/**
 * 本地 LLM 后端 — 集成到 xangi 本体中
 *
 * 直接调用 Ollama 等 OpenAI 兼容 API 来执行代理循环。
 * 不需要外部 HTTP 服务器。
 */
import type { AgentRunner, RunOptions, RunResult, StreamCallbacks } from '../agent-runner.js';
import type { AgentConfig } from '../config.js';
import type { LLMMessage, LLMImageContent } from './types.js';
import { LLMClient } from './llm-client.js';
import { extractAttachmentPaths, encodeImageToBase64, getMimeType } from './image-utils.js';
import { loadWorkspaceContext } from './context.js';
import { getAllTools, toLLMTools, executeTool, registerDynamicTools } from './tools.js';
import { loadSkills } from '../skills.js';
import { CHAT_SYSTEM_PROMPT_PERSISTENT, XANGI_COMMANDS } from '../base-runner.js';
import { TOOLS_USAGE_PROMPT } from '../prompts/index.js';
import { checkApprovalServer } from '../approval-server.js';
import { logPrompt, logResponse, logError } from '../transcript-logger.js';
import { loadTriggers, triggersToToolHandlers, type Trigger } from './triggers.js';
import { getAllXangiTools } from './xangi-tools.js';

const MAX_TOOL_ROUNDS = 10;
const MAX_SESSION_MESSAGES = 50;
const MAX_TOOL_OUTPUT_CHARS = 8000;

// 上下文修剪设置（参照 karaagebot 标准）
const CONTEXT_MAX_CHARS = 120000; // 约 48000 token（1 token ≈ 2.5 字符）
const CONTEXT_KEEP_LAST = 10; // 保留最近 10 条
const TOOL_RESULT_MAX_CHARS_IN_CONTEXT = 4000; // 上下文中工具结果的最大长度

/** 截断工具结果（head/tail 方式，参照 karaagebot 标准） */
function trimToolResult(content: string, maxChars: number = MAX_TOOL_OUTPUT_CHARS): string {
  if (content.length <= maxChars) return content;
  const headChars = Math.floor(maxChars * 0.4);
  const tailChars = Math.floor(maxChars * 0.4);
  return (
    content.slice(0, headChars) +
    `\n\n... [已截断 ${content.length - headChars - tailChars} 字符] ...\n\n` +
    content.slice(-tailChars)
  );
}

/** 会话（对话历史） */
interface Session {
  messages: LLMMessage[];
  updatedAt: number;
}

/** 判断 LLM 错误是否与会话历史相关 */
export function isSessionRelatedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('context length') ||
    msg.includes('too many tokens') ||
    msg.includes('max_tokens') ||
    msg.includes('context window') ||
    msg.includes('invalid message') ||
    msg.includes('malformed') ||
    msg.includes('400') ||
    msg.includes('422')
  );
}

/** 生成面向用户的错误消息 */
export function formatLlmError(err: unknown): string {
  if (!(err instanceof Error)) return '与 LLM 通信时发生意外错误。';
  const msg = err.message;
  if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
    return '无法连接到 LLM 服务器。请确认服务器是否已启动。';
  }
  if (msg.includes('timeout') || msg.includes('aborted')) {
    return 'LLM 响应超时。请稍后重试。';
  }
  if (msg.includes('401') || msg.includes('403')) {
    return 'LLM 服务器认证失败。请检查 API 密钥。';
  }
  if (msg.includes('429')) {
    return '已达到 LLM 服务器的速率限制。请稍后重试。';
  }
  if (msg.includes('500') || msg.includes('502') || msg.includes('503')) {
    return 'LLM 服务器发生内部错误。请稍后重试。';
  }
  return `LLM 错误: ${msg}`;
}

export class LocalLlmRunner implements AgentRunner {
  private readonly llm: LLMClient;
  private readonly workdir: string;
  private readonly sessions = new Map<string, Session>();
  private readonly sessionTtlMs = 60 * 60 * 1000; // 1 小时
  private readonly activeAbortControllers = new Map<string, AbortController>();
  /** 各项功能开关 */
  readonly enableTools: boolean;
  readonly enableSkills: boolean;
  readonly enableXangiCommands: boolean;
  readonly enableTriggers: boolean;
  /** 触发器定义 */
  private triggers: Trigger[];

  constructor(config: AgentConfig) {
    const baseUrl = (process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
    const model = config.model || process.env.LOCAL_LLM_MODEL || '';
    const apiKey = process.env.LOCAL_LLM_API_KEY || '';
    const thinking = process.env.LOCAL_LLM_THINKING !== 'false';
    const maxTokens = process.env.LOCAL_LLM_MAX_TOKENS
      ? parseInt(process.env.LOCAL_LLM_MAX_TOKENS, 10)
      : 8192;
    const numCtx = process.env.LOCAL_LLM_NUM_CTX
      ? parseInt(process.env.LOCAL_LLM_NUM_CTX, 10)
      : undefined;

    // 各项开关（通过环境变量控制，未设置时从 LOCAL_LLM_MODE 推断）
    const modeEnv = (process.env.LOCAL_LLM_MODE || '').toLowerCase();
    const modeDefaults = {
      agent: { tools: true, skills: true, xangiCommands: true, triggers: false },
      chat: { tools: false, skills: false, xangiCommands: false, triggers: false },
      lite: { tools: true, skills: false, xangiCommands: false, triggers: true },
    };
    const defaults = modeDefaults[modeEnv as keyof typeof modeDefaults] || modeDefaults.agent;

    this.enableTools =
      process.env.LOCAL_LLM_TOOLS !== undefined
        ? process.env.LOCAL_LLM_TOOLS !== 'false'
        : defaults.tools;
    this.enableSkills =
      process.env.LOCAL_LLM_SKILLS !== undefined
        ? process.env.LOCAL_LLM_SKILLS !== 'false'
        : defaults.skills;
    this.enableXangiCommands =
      process.env.LOCAL_LLM_XANGI_COMMANDS !== undefined
        ? process.env.LOCAL_LLM_XANGI_COMMANDS !== 'false'
        : defaults.xangiCommands;
    this.enableTriggers =
      process.env.LOCAL_LLM_TRIGGERS !== undefined
        ? process.env.LOCAL_LLM_TRIGGERS !== 'false'
        : defaults.triggers;

    this.llm = new LLMClient(baseUrl, model, apiKey, thinking, maxTokens, numCtx);
    this.workdir = config.workdir || process.cwd();

    // 加载触发器
    this.triggers = this.enableTriggers ? loadTriggers(this.workdir) : [];

    // 如果工具模式启用，将触发器和 xangi 命令注册为工具
    if (this.enableTools) {
      const dynamicTools = [];

      if (this.triggers.length > 0) {
        const triggerTools = triggersToToolHandlers(this.triggers, this.workdir);
        dynamicTools.push(...triggerTools);
        console.log(
          `[local-llm] 触发器已注册为工具: ${triggerTools.map((t) => t.name).join(', ')}`
        );
      }

      if (this.enableXangiCommands) {
        const xangiTools = getAllXangiTools();
        dynamicTools.push(...xangiTools);
        console.log(
          `[local-llm] Xangi 命令已注册为工具: ${xangiTools.map((t) => t.name).join(', ')}`
        );
      }

      if (dynamicTools.length > 0) {
        registerDynamicTools(dynamicTools);
      }
    }

    const features =
      [
        this.enableTools && 'tools',
        this.enableSkills && 'skills',
        this.enableXangiCommands && 'xangi-commands',
        this.enableTriggers && 'triggers',
      ]
        .filter(Boolean)
        .join(', ') || 'chat-only';
    console.log(
      `[local-llm] LLM: ${baseUrl} (模型: ${model}, 思考模式: ${thinking}, 功能: ${features})`
    );
  }

  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    const sessionId = options?.sessionId || crypto.randomUUID();
    this.cleanupSessions();

    const session = this.getOrCreateSession(sessionId);
    const systemPrompt = this.buildSystemPrompt();
    const tools = this.enableTools ? getAllTools() : [];
    const llmTools = this.enableTools ? toLLMTools(tools) : [];

    // 添加用户消息（如有图片附件则构建多模态消息）
    const userMsg = this.buildUserMessage(prompt);
    session.messages.push(userMsg);

    // 记录提示词到转录日志
    const channelId = options?.channelId || sessionId;
    const appSid = options?.appSessionId || channelId;
    logPrompt(this.workdir, appSid, prompt);

    // 创建 AbortController 并注册（相当于 processManager）
    const abortController = new AbortController();
    this.activeAbortControllers.set(channelId, abortController);

    try {
      const result = await this.executeAgentLoop(
        session,
        systemPrompt,
        llmTools,
        channelId,
        sessionId,
        abortController,
        options,
        appSid
      );

      this.trimSession(session);
      session.updatedAt = Date.now();

      // 记录响应到转录日志
      logResponse(this.workdir, appSid, { result, sessionId });

      return { result, sessionId };
    } catch (err) {
      // 如果是会话历史导致的错误，清除会话并重试
      if (session.messages.length > 1 && isSessionRelatedError(err)) {
        console.warn(
          `[local-llm] 会话相关错误，使用新会话重试: ${err instanceof Error ? err.message : String(err)}`
        );
        logError(
          this.workdir,
          appSid,
          `会话恢复失败，正在重试: ${err instanceof Error ? err.message : String(err)}`
        );

        // 清除会话，只保留最后一条用户消息
        session.messages = [userMsg];

        try {
          const retryAbortController = new AbortController();
          this.activeAbortControllers.set(channelId, retryAbortController);

          const result = await this.executeAgentLoop(
            session,
            systemPrompt,
            llmTools,
            channelId,
            sessionId,
            retryAbortController,
            options,
            appSid
          );

          this.trimSession(session);
          session.updatedAt = Date.now();
          logResponse(this.workdir, appSid, { result, sessionId });

          return { result, sessionId };
        } catch (retryErr) {
          const errorMsg = formatLlmError(retryErr);
          logError(
            this.workdir,
            appSid,
            `LLM 聊天重试失败: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
          );
          return { result: errorMsg, sessionId };
        }
      }

      const errorMsg = formatLlmError(err);
      logError(
        this.workdir,
        appSid,
        `LLM 聊天错误: ${err instanceof Error ? err.message : String(err)}`
      );
      return { result: errorMsg, sessionId };
    } finally {
      this.activeAbortControllers.delete(channelId);
    }
  }

  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    const sessionId = options?.sessionId || crypto.randomUUID();
    this.cleanupSessions();

    const session = this.getOrCreateSession(sessionId);
    const systemPrompt = this.buildSystemPrompt();
    const tools = this.enableTools ? getAllTools() : [];
    const llmTools = this.enableTools ? toLLMTools(tools) : [];

    const userMsg = this.buildUserMessage(prompt);
    session.messages.push(userMsg);

    const channelId = options?.channelId || sessionId;
    const appSid = options?.appSessionId || channelId;

    // 记录提示词到转录日志
    logPrompt(this.workdir, appSid, prompt);
    const abortController = new AbortController();
    this.activeAbortControllers.set(channelId, abortController);

    try {
      const fullText = await this.executeStreamLoop(
        session,
        systemPrompt,
        llmTools,
        channelId,
        sessionId,
        abortController,
        callbacks,
        options,
        appSid
      );

      session.messages.push({ role: 'assistant', content: fullText });

      this.trimSession(session);
      session.updatedAt = Date.now();

      // 记录响应到转录日志
      logResponse(this.workdir, appSid, { result: fullText, sessionId });

      const result: RunResult = { result: fullText, sessionId };
      callbacks.onComplete?.(result);
      return result;
    } catch (err) {
      // 如果是会话历史导致的错误，清除会话并重试
      if (session.messages.length > 1 && isSessionRelatedError(err)) {
        console.warn(
          `[local-llm] 会话相关流式错误，使用新会话重试: ${err instanceof Error ? err.message : String(err)}`
        );
        logError(
          this.workdir,
          appSid,
          `会话恢复失败（流式），正在重试: ${err instanceof Error ? err.message : String(err)}`
        );

        // 清除会话，只保留最后一条用户消息
        session.messages = [userMsg];

        try {
          const retryAbortController = new AbortController();
          this.activeAbortControllers.set(channelId, retryAbortController);

          const fullText = await this.executeStreamLoop(
            session,
            systemPrompt,
            llmTools,
            channelId,
            sessionId,
            retryAbortController,
            callbacks,
            options,
            appSid
          );

          session.messages.push({ role: 'assistant', content: fullText });
          this.trimSession(session);
          session.updatedAt = Date.now();
          logResponse(this.workdir, appSid, { result: fullText, sessionId });

          const result: RunResult = { result: fullText, sessionId };
          callbacks.onComplete?.(result);
          return result;
        } catch (retryErr) {
          const error = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
          const errorMsg = formatLlmError(retryErr);
          logError(this.workdir, appSid, `LLM 流式重试失败: ${error.message}`);
          callbacks.onError?.(error);
          return { result: errorMsg, sessionId };
        }
      }

      const error = err instanceof Error ? err : new Error(String(err));
      const errorMsg = formatLlmError(err);
      logError(this.workdir, appSid, `LLM 流式错误: ${error.message}`);
      callbacks.onError?.(error);
      return { result: errorMsg, sessionId };
    } finally {
      this.activeAbortControllers.delete(channelId);
    }
  }

  cancel(channelId?: string): boolean {
    if (channelId) {
      const controller = this.activeAbortControllers.get(channelId);
      if (controller) {
        controller.abort();
        this.activeAbortControllers.delete(channelId);
        return true;
      }
    }
    // 如果 channelId 未知，则停止所有
    if (this.activeAbortControllers.size > 0) {
      for (const [id, controller] of this.activeAbortControllers) {
        controller.abort();
        this.activeAbortControllers.delete(id);
      }
      return true;
    }
    return false;
  }

  destroy(channelId: string): boolean {
    // 如果使用 channelId 作为会话 ID，则删除
    this.sessions.delete(channelId);
    return true;
  }

  /**
   * 代理循环（run 用）：包含工具调用的非流式执行
   * lite 模式下，不调用工具，一次请求完成。
   */
  private async executeAgentLoop(
    session: Session,
    systemPrompt: string,
    llmTools: ReturnType<typeof toLLMTools>,
    channelId: string,
    sessionId: string,
    abortController: AbortController,
    options?: RunOptions,
    appSessionId?: string
  ): Promise<string> {
    const logId = appSessionId || channelId;
    // 工具禁用：一次 LLM 调用完成 + 触发器检测
    if (!this.enableTools) {
      let response;
      try {
        response = await this.llm.chat(session.messages, {
          systemPrompt,
          signal: abortController.signal,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[local-llm] LLM 聊天调用失败: ${errorMsg}`);
        logError(this.workdir, logId, `LLM 聊天调用失败: ${errorMsg}`);
        throw err;
      }
      session.messages.push({ role: 'assistant', content: response.content });

      return response.content;
    }

    let toolRounds = 0;
    let finalContent = '';
    const pendingMediaPaths: string[] = [];

    while (toolRounds <= MAX_TOOL_ROUNDS) {
      let response;
      try {
        response = await this.llm.chat(session.messages, {
          systemPrompt,
          tools: llmTools.length > 0 ? llmTools : undefined,
          signal: abortController.signal,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[local-llm] LLM 聊天调用失败: ${errorMsg}`);
        logError(this.workdir, logId, `LLM 聊天调用失败: ${errorMsg}`);
        throw err;
      }

      if (
        response.finishReason === 'stop' ||
        !response.toolCalls ||
        response.toolCalls.length === 0
      ) {
        finalContent = response.content;
        session.messages.push({ role: 'assistant', content: response.content });
        break;
      }

      // 工具调用
      session.messages.push({
        role: 'assistant',
        content: response.content ?? '',
        toolCalls: response.toolCalls,
      });

      const toolContext = { workspace: this.workdir, channelId: options?.channelId };

      for (const toolCall of response.toolCalls) {
        console.log(
          `[local-llm] 工具调用: ${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 200)})`
        );

        // 危险命令审批检查（通过审批服务器，与 Claude Code 机制相同）
        const approvalResult = await checkApprovalServer(toolCall.name, toolCall.arguments);
        if (approvalResult === 'deny') {
          console.log(`[local-llm] 工具被审批服务器拒绝: ${toolCall.name}`);
          session.messages.push({
            role: 'tool',
            content: '用户拒绝了工具执行。',
          });
          continue;
        }

        const result = await executeTool(toolCall.name, toolCall.arguments, toolContext);
        const rawOutput = result.success
          ? result.output
          : `错误: ${result.error ?? '未知错误'}${result.output ? `\n输出: ${result.output}` : ''}`;
        const toolResultContent = trimToolResult(rawOutput);

        if (!result.success) {
          logError(this.workdir, logId, `工具 ${toolCall.name} 失败: ${rawOutput}`);
        }

        console.log(
          `[local-llm] 工具结果: ${result.success ? '成功' : '失败'} (${toolResultContent.length} 字符)`
        );
        session.messages.push({
          role: 'tool',
          content: toolResultContent,
          toolCallId: toolCall.id,
        });

        // 从工具结果中收集 MEDIA: 路径
        const mediaPattern = /^MEDIA:(.+)$/gm;
        for (const mediaMatch of rawOutput.matchAll(mediaPattern)) {
          const mediaPath = mediaMatch[1].trim();
          if (!pendingMediaPaths.includes(mediaPath)) {
            pendingMediaPaths.push(mediaPath);
            console.log(`[local-llm] 从工具结果检测到媒体路径: ${mediaPath}`);
          }
        }
      }

      toolRounds++;
      if (toolRounds >= MAX_TOOL_ROUNDS) {
        finalContent = '已达到最大工具调用轮次。';
        break;
      }
    }

    // 将从工具结果中检测到的 MEDIA: 路径附加到最终响应
    if (pendingMediaPaths.length > 0) {
      finalContent += '\n' + pendingMediaPaths.map((p) => `MEDIA:${p}`).join('\n');
    }

    return finalContent;
  }

  /**
   * 流式循环：工具调用 + 最终响应流式输出
   * lite 模式下跳过工具循环，直接流式响应。
   */
  private async executeStreamLoop(
    session: Session,
    systemPrompt: string,
    llmTools: ReturnType<typeof toLLMTools>,
    channelId: string,
    sessionId: string,
    abortController: AbortController,
    callbacks: StreamCallbacks,
    options?: RunOptions,
    appSessionId?: string
  ): Promise<string> {
    const logId = appSessionId || channelId;
    const pendingMediaPaths: string[] = [];

    // 仅在工具启用时执行工具循环
    if (this.enableTools) {
      // 工具循环：使用非流式 chat() 处理工具调用
      let toolRounds = 0;
      while (toolRounds < MAX_TOOL_ROUNDS) {
        let response;
        try {
          response = await this.llm.chat(session.messages, {
            systemPrompt,
            tools: llmTools.length > 0 ? llmTools : undefined,
            signal: abortController.signal,
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.error(`[local-llm] LLM 聊天调用失败（流式工具循环）: ${errorMsg}`);
          logError(this.workdir, logId, `LLM 聊天调用失败（流式工具循环）: ${errorMsg}`);
          throw err;
        }

        if (!response.toolCalls || response.toolCalls.length === 0) {
          break;
        }

        // 工具调用处理
        session.messages.push({
          role: 'assistant',
          content: response.content ?? '',
          toolCalls: response.toolCalls,
        });

        const toolContext = { workspace: this.workdir, channelId: options?.channelId };
        for (const toolCall of response.toolCalls) {
          console.log(
            `[local-llm] 工具调用: ${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 200)})`
          );

          // 危险命令审批检查（通过审批服务器，与 Claude Code 机制相同）
          const approvalResult2 = await checkApprovalServer(toolCall.name, toolCall.arguments);
          if (approvalResult2 === 'deny') {
            console.log(`[local-llm] 工具被审批服务器拒绝: ${toolCall.name}`);
            session.messages.push({
              role: 'tool',
              content: '用户拒绝了工具执行。',
            });
            continue;
          }

          const result = await executeTool(toolCall.name, toolCall.arguments, toolContext);
          const rawToolOutput = result.success
            ? result.output
            : `错误: ${result.error ?? '未知错误'}${result.output ? `\n输出: ${result.output}` : ''}`;
          const toolResultContent = trimToolResult(rawToolOutput);
          if (!result.success) {
            logError(this.workdir, logId, `工具 ${toolCall.name} 失败: ${rawToolOutput}`);
          }
          console.log(
            `[local-llm] 工具结果: ${result.success ? '成功' : '失败'} (${toolResultContent.length} 字符)`
          );
          session.messages.push({
            role: 'tool',
            content: toolResultContent,
            toolCallId: toolCall.id,
          });

          // 从工具结果中收集 MEDIA: 路径
          const mediaPattern = /^MEDIA:(.+)$/gm;
          for (const mediaMatch of rawToolOutput.matchAll(mediaPattern)) {
            const mediaPath = mediaMatch[1].trim();
            if (!pendingMediaPaths.includes(mediaPath)) {
              pendingMediaPaths.push(mediaPath);
              console.log(`[local-llm] 从工具结果检测到媒体路径: ${mediaPath}`);
            }
          }
        }
        toolRounds++;
      }
    }

    // 流式获取最终响应
    let fullText = '';
    try {
      for await (const chunk of this.llm.chatStream(session.messages, {
        systemPrompt,
        signal: abortController.signal,
      })) {
        fullText += chunk;
        callbacks.onText?.(chunk, fullText);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[local-llm] LLM chatStream 失败: ${errorMsg}`);
      logError(this.workdir, logId, `LLM chatStream 失败: ${errorMsg}`);
      throw err;
    }

    // 将从工具结果中检测到的 MEDIA: 路径附加到最终响应
    if (pendingMediaPaths.length > 0) {
      fullText += '\n' + pendingMediaPaths.map((p) => `MEDIA:${p}`).join('\n');
    }

    return fullText;
  }

  /**
   * 从提示词构建用户消息。
   * 如果附件中包含图片，则构建多模态消息。
   */
  private buildUserMessage(prompt: string): LLMMessage {
    const { imagePaths, otherPaths, cleanPrompt } = extractAttachmentPaths(prompt);

    // 将图片编码为 base64
    const images: LLMImageContent[] = [];
    for (const imagePath of imagePaths) {
      const base64 = encodeImageToBase64(imagePath);
      if (base64) {
        const mimeType = getMimeType(imagePath);
        images.push({ base64, mimeType });
        console.log(`[local-llm] 已附加图片: ${imagePath} (${mimeType})`);
      }
    }

    // 如果有非图片文件，在文本中保留附件信息
    let content = cleanPrompt;
    if (otherPaths.length > 0) {
      const fileList = otherPaths.map((p) => `  - ${p}`).join('\n');
      content = `${cleanPrompt}\n\n[附件]\n${fileList}`;
    }

    const msg: LLMMessage = { role: 'user', content };
    if (images.length > 0) {
      msg.images = images;
    }
    return msg;
  }

  private buildSystemPrompt(): string {
    const parts: string[] = [];

    // 注入 XANGI_COMMANDS
    if (this.enableXangiCommands) {
      parts.push(CHAT_SYSTEM_PROMPT_PERSISTENT + '\n\n## XANGI_COMMANDS.md\n\n' + XANGI_COMMANDS);
    }

    // 工作区上下文（CLAUDE.md, AGENTS.md, MEMORY.md）— 始终注入
    const context = loadWorkspaceContext(this.workdir);
    if (context) parts.push(context);

    // 触发器（每次重新加载）
    if (this.enableTriggers) {
      this.triggers = loadTriggers(this.workdir);
      if (this.triggers.length > 0) {
        if (this.enableTools) {
          // 工具模式：将触发器注册为工具，并将使用说明添加到提示词
          const triggerTools = triggersToToolHandlers(this.triggers, this.workdir);
          registerDynamicTools(triggerTools);
          const toolLines = this.triggers.map((t) => `- **${t.name}**(参数): ${t.description}`);
          parts.push(
            [
              '## 自定义工具',
              '',
              '以下工具可用。对于相关请求，**必须调用工具**。不要凭自己的知识回答。',
              '',
              ...toolLines,
            ].join('\n')
          );
        }
      }
    }

    // 技能列表
    if (this.enableSkills) {
      const skills = loadSkills(this.workdir);
      if (skills.length > 0) {
        const skillLines = skills
          .map((s) => `  - **${s.name}**: ${s.description}\n    SKILL.md: ${s.path}`)
          .join('\n');
        parts.push(
          `## 可用技能\n\n在使用技能前，请使用 read 工具加载 SKILL.md。切勿猜测命令 — 始终先阅读 SKILL.md。\n${skillLines}`
        );
      }
    }

    // 工具启用时注入工具使用说明提示词
    if (this.enableTools) {
      parts.push(TOOLS_USAGE_PROMPT);
    }

    return parts.join('\n\n');
  }

  private getOrCreateSession(sessionId: string): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { messages: [], updatedAt: Date.now() };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  /**
   * 上下文修剪（参照 karaagebot 标准）
   * 1. 将工具结果截断至 TOOL_RESULT_MAX_CHARS_IN_CONTEXT
   * 2. 保留最近 CONTEXT_KEEP_LAST 条消息
   * 3. 如果总字符数超过 CONTEXT_MAX_CHARS，从旧消息开始删除
   * 4. 如果消息数量超过 MAX_SESSION_MESSAGES，删除旧消息
   */
  private trimSession(session: Session): void {
    // 截断工具结果（在上下文中）
    for (const msg of session.messages) {
      if (msg.role === 'tool' && msg.content.length > TOOL_RESULT_MAX_CHARS_IN_CONTEXT) {
        const head = Math.floor(TOOL_RESULT_MAX_CHARS_IN_CONTEXT * 0.4);
        const tail = Math.floor(TOOL_RESULT_MAX_CHARS_IN_CONTEXT * 0.4);
        msg.content =
          msg.content.slice(0, head) +
          `\n\n... [为节省上下文，已截断 ${msg.content.length - head - tail} 字符] ...\n\n` +
          msg.content.slice(-tail);
      }
    }

    // 消息数量限制
    if (session.messages.length > MAX_SESSION_MESSAGES) {
      session.messages = session.messages.slice(-MAX_SESSION_MESSAGES);
    }

    // 总字符数限制（保留最近 CONTEXT_KEEP_LAST 条）
    let totalChars = session.messages.reduce((sum, m) => sum + m.content.length, 0);
    while (totalChars > CONTEXT_MAX_CHARS && session.messages.length > CONTEXT_KEEP_LAST) {
      const removed = session.messages.shift();
      if (removed) totalChars -= removed.content.length;
    }
  }

  private cleanupSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.updatedAt > this.sessionTtlMs) {
        this.sessions.delete(id);
      }
    }
  }
}
