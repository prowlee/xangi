import type { AgentBackend, AgentConfig, EffortLevel } from './config.js';
import { ClaudeCodeRunner } from './claude-code.js';
import { CodexRunner } from './codex-cli.js';
import { GeminiRunner } from './gemini-cli.js';
import { LocalLlmRunner } from './local-llm/runner.js';
import { RunnerManager } from './runner-manager.js';

export interface RunOptions {
  skipPermissions?: boolean;
  sessionId?: string;
  channelId?: string; // 用于进程管理
  appSessionId?: string; // xangi 侧会话 ID（用于日志）
  effort?: EffortLevel; // Claude Code 的 --effort 选项
}

export interface RunResult {
  result: string;
  sessionId: string;
}

export interface StreamCallbacks {
  onText?: (text: string, fullText: string) => void;
  onToolUse?: (toolName: string, toolInput: Record<string, unknown>) => void;
  onComplete?: (result: RunResult) => void;
  onError?: (error: Error) => void;
}

/**
 * AI 代理运行器的统一接口
 */
export interface AgentRunner {
  run(prompt: string, options?: RunOptions): Promise<RunResult>;
  runStream(prompt: string, callbacks: StreamCallbacks, options?: RunOptions): Promise<RunResult>;
  /** 取消当前正在处理的请求 */
  cancel?(channelId?: string): boolean;
  /** 完全销毁指定频道的运行器（用于 /new） */
  destroy?(channelId: string): boolean;
}

/**
 * 根据配置创建 AgentRunner
 */
export function createAgentRunner(
  backend: AgentBackend,
  config: AgentConfig,
  options?: { platform?: import('./prompts/index.js').ChatPlatform }
): AgentRunner {
  switch (backend) {
    case 'claude-code':
      // persistent 模式使用 RunnerManager（多频道同时处理）
      if (config.persistent) {
        console.log('[agent-runner] Using RunnerManager (multi-channel high-speed mode)');
        return new RunnerManager(config, {
          maxProcesses: config.maxProcesses,
          idleTimeoutMs: config.idleTimeoutMs,
          platform: options?.platform,
        });
      }
      return new ClaudeCodeRunner({ ...config, platform: options?.platform });
    case 'codex':
      return new CodexRunner(config);
    case 'gemini':
      return new GeminiRunner(config);
    case 'local-llm':
      return new LocalLlmRunner(config);
    default:
      throw new Error(`Unknown agent backend: ${backend}`);
  }
}

/**
 * 合并流式传输中累积的文本和最终的 result 文本。
 *
 * Claude Code CLI 在工具调用之间会输出文本，
 * 但最终的 result 字段只包含最后一个文本块。
 * 此函数以累积文本（streamed）为基础，如果 result 中有额外文本则添加。
 */
export function mergeTexts(streamed: string, result: string): string {
  if (!result) return streamed;
  if (!streamed) return result;

  // 如果 result 包含在 streamed 末尾，说明重复 → 直接返回 streamed
  if (streamed.endsWith(result)) return streamed;

  // 如果 streamed 完全包含在 result 中，则优先使用 result
  if (result.endsWith(streamed)) return result;

  // 都不包含 → 用分隔符连接
  return `${streamed}\n${result}`;
}

/** 移除无效的代理对（孤立的代理项） */
export function sanitizeSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    ''
  );
}

/**
 * 将后端名称转换为显示用名称
 */
export function getBackendDisplayName(backend: AgentBackend): string {
  switch (backend) {
    case 'claude-code':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'local-llm':
      return 'Local LLM';
    default:
      return backend;
  }
}
