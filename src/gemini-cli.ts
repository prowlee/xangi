import { spawn, ChildProcess } from 'child_process';
import { processManager } from './process-manager.js';
import type { AgentRunner, RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';
import { DEFAULT_TIMEOUT_MS } from './constants.js';
import { getSafeEnv, buildSystemPrompt } from './base-runner.js';
import type { BaseRunnerOptions } from './base-runner.js';
import { getGitHubEnv } from './github-auth.js';
import { logPrompt, logResponse } from './transcript-logger.js';

/**
 * Gemini CLI 的 JSON 输出格式
 */
interface GeminiJsonResponse {
  session_id: string;
  response: string;
  stats?: {
    models?: Record<string, unknown>;
  };
}

/**
 * Gemini CLI 的 stream-json 事件格式
 */
interface GeminiStreamEvent {
  type: 'init' | 'message' | 'result';
  timestamp?: string;
  session_id?: string;
  role?: 'user' | 'assistant';
  content?: string;
  delta?: boolean;
  status?: 'success' | 'error';
  stats?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cached?: number;
    duration_ms?: number;
    tool_calls?: number;
  };
}

/**
 * 执行 Gemini CLI 的运行器
 */
export class GeminiRunner implements AgentRunner {
  private model?: string;
  private timeoutMs: number;
  private workdir?: string;
  private skipPermissions: boolean;
  private currentProcess: ChildProcess | null = null;

  constructor(options?: BaseRunnerOptions) {
    this.model = options?.model;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.workdir = options?.workdir;
    this.skipPermissions = options?.skipPermissions ?? false;
  }

  /**
   * 构建命令参数（run/runStream 公共部分）
   */
  private buildBaseArgs(options?: RunOptions): string[] {
    const args: string[] = [];

    const skip = options?.skipPermissions ?? this.skipPermissions;
    if (skip) {
      args.push('--yolo');
    }

    if (this.model) {
      args.push('--model', this.model);
    }

    // 会话延续
    if (options?.sessionId) {
      args.push('--resume', options.sessionId);
    }

    return args;
  }

  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    const systemPrompt = buildSystemPrompt();
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
    const args = [
      ...this.buildBaseArgs(options),
      '--prompt',
      fullPrompt,
      '--output-format',
      'json',
    ];

    const sessionInfo = options?.sessionId
      ? ` (会话: ${options.sessionId.slice(0, 8)}...)`
      : ' (新会话)';
    console.log(`[gemini] 在 ${this.workdir || '默认目录'} 中执行${sessionInfo}`);

    // 转录日志：记录发送的提示词
    if (options?.appSessionId && this.workdir) {
      logPrompt(this.workdir, options.appSessionId, fullPrompt);
    }

    try {
      const { stdout, sessionId } = await this.execute(args, options?.channelId);
      const response = this.parseJsonResponse(stdout);

      // 转录日志：记录响应
      if (options?.appSessionId && this.workdir) {
        logResponse(this.workdir, options.appSessionId, {
          result: response.response,
          sessionId: sessionId || response.session_id,
        });
      }

      return {
        result: response.response,
        sessionId: sessionId || response.session_id,
      };
    } catch (err) {
      // 会话恢复失败时，使用新会话重试
      if (options?.sessionId && err instanceof Error && err.message.includes('exited with code')) {
        console.warn(`[gemini] 会话恢复失败，将在无会话情况下重试: ${err.message}`);
        const retryArgs = [
          ...this.buildBaseArgs({ ...options, sessionId: undefined }),
          '--prompt',
          fullPrompt,
          '--output-format',
          'json',
        ];
        const { stdout, sessionId } = await this.execute(retryArgs, options?.channelId);
        const response = this.parseJsonResponse(stdout);

        // 转录日志：记录重试响应
        if (options?.appSessionId && this.workdir) {
          logResponse(this.workdir, options.appSessionId, {
            result: response.response,
            sessionId: sessionId || response.session_id,
          });
        }

        return {
          result: response.response,
          sessionId: sessionId || response.session_id,
        };
      }
      throw err;
    }
  }

  private execute(
    args: string[],
    channelId?: string
  ): Promise<{ stdout: string; sessionId: string }> {
    const safeEnv = getSafeEnv();
    return new Promise((resolve, reject) => {
      const proc = spawn('gemini', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.workdir,
        env: { ...safeEnv, ...getGitHubEnv(safeEnv) },
      });
      this.currentProcess = proc;

      if (channelId) {
        processManager.register(channelId, proc);
      }

      let stdout = '';
      let stderr = '';
      let sessionId = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill();
        this.currentProcess = null;
        reject(new Error(`Gemini CLI 超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        this.currentProcess = null;

        if (code !== 0) {
          reject(new Error(`Gemini CLI 退出，代码 ${code}: ${stderr}`));
          return;
        }

        // 从 JSON 输出中提取 session_id
        try {
          const json = JSON.parse(stdout.trim()) as GeminiJsonResponse;
          sessionId = json.session_id;
        } catch {
          // 即使解析失败，也原样返回 stdout
        }

        resolve({ stdout, sessionId });
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        this.currentProcess = null;
        reject(new Error(`无法启动 Gemini CLI: ${err.message}`));
      });
    });
  }

  private parseJsonResponse(output: string): GeminiJsonResponse {
    try {
      return JSON.parse(output.trim()) as GeminiJsonResponse;
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`解析 Gemini CLI 响应失败: ${output}`);
      }
      throw err;
    }
  }

  /**
   * 流式执行
   */
  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    const systemPrompt = buildSystemPrompt();
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
    const args = [
      ...this.buildBaseArgs(options),
      '--prompt',
      fullPrompt,
      '--output-format',
      'stream-json',
    ];

    const sessionInfo = options?.sessionId
      ? ` (会话: ${options.sessionId.slice(0, 8)}...)`
      : ' (新会话)';
    console.log(`[gemini] 在 ${this.workdir || '默认目录'} 中流式执行${sessionInfo}`);

    // 转录日志：记录发送的提示词
    if (options?.appSessionId && this.workdir) {
      logPrompt(this.workdir, options.appSessionId, fullPrompt);
    }

    try {
      return await this.executeStream(args, callbacks, options?.channelId, options?.appSessionId);
    } catch (err) {
      // 会话恢复失败时，使用新会话重试
      if (options?.sessionId && err instanceof Error && err.message.includes('exited with code')) {
        console.warn(`[gemini] 会话恢复失败，将在无会话情况下重试: ${err.message}`);
        const retryArgs = [
          ...this.buildBaseArgs({ ...options, sessionId: undefined }),
          '--prompt',
          fullPrompt,
          '--output-format',
          'stream-json',
        ];
        return this.executeStream(retryArgs, callbacks, options?.channelId, options?.appSessionId);
      }
      throw err;
    }
  }

  private executeStream(
    args: string[],
    callbacks: StreamCallbacks,
    channelId?: string,
    appSessionId?: string
  ): Promise<RunResult> {
    const safeEnv = getSafeEnv();
    return new Promise((resolve, reject) => {
      const proc = spawn('gemini', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.workdir,
        env: { ...safeEnv, ...getGitHubEnv(safeEnv) },
      });
      this.currentProcess = proc;

      if (channelId) {
        processManager.register(channelId, proc);
      }

      let fullText = '';
      let sessionId = '';
      let buffer = '';

      proc.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line) as GeminiStreamEvent;

            // 获取会话 ID（在 init 事件中返回）
            if (json.type === 'init' && json.session_id) {
              sessionId = json.session_id;
            }

            // 助手的消息（delta）
            if (json.type === 'message' && json.role === 'assistant' && json.content) {
              fullText += json.content;
              callbacks.onText?.(json.content, fullText);
            }

            // 结果
            if (json.type === 'result') {
              if (json.session_id) {
                sessionId = json.session_id;
              }
              if (json.status === 'error') {
                const error = new Error('Gemini CLI 返回错误');
                callbacks.onError?.(error);
                reject(error);
                return;
              }
              // 记录 Token 使用量
              if (json.stats) {
                console.log(
                  `[gemini] 使用量: input=${json.stats.input_tokens ?? 0}, output=${json.stats.output_tokens ?? 0}, cached=${json.stats.cached ?? 0}, duration=${json.stats.duration_ms ?? 0}ms`
                );
              }
            }
          } catch {
            // 忽略 JSON 解析错误
          }
        }
      });

      proc.stderr.on('data', (data) => {
        console.error('[gemini] stderr:', data.toString());
      });

      const timeout = setTimeout(() => {
        proc.kill();
        this.currentProcess = null;
        const error = new Error(`Gemini CLI 超时（${this.timeoutMs}ms）`);
        callbacks.onError?.(error);
        reject(error);
      }, this.timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        this.currentProcess = null;

        // 处理剩余的缓冲区
        if (buffer.trim()) {
          try {
            const json = JSON.parse(buffer) as GeminiStreamEvent;
            if (json.type === 'init' && json.session_id) {
              sessionId = json.session_id;
            }
            if (json.type === 'message' && json.role === 'assistant' && json.content) {
              fullText += json.content;
            }
            if (json.type === 'result' && json.session_id) {
              sessionId = json.session_id;
            }
          } catch {
            // 忽略 JSON 解析错误
          }
        }

        if (code !== 0) {
          const error = new Error(`Gemini CLI 退出，代码 ${code}`);
          callbacks.onError?.(error);
          reject(error);
          return;
        }

        const result: RunResult = { result: fullText, sessionId };

        // 转录日志：记录响应
        if (appSessionId && this.workdir) {
          logResponse(this.workdir, appSessionId, { result: fullText, sessionId });
        }

        callbacks.onComplete?.(result);
        resolve(result);
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        this.currentProcess = null;
        const error = new Error(`无法启动 Gemini CLI: ${err.message}`);
        callbacks.onError?.(error);
        reject(error);
      });
    });
  }

  /**
   * 取消当前正在处理的请求
   */
  cancel(): boolean {
    if (!this.currentProcess) {
      return false;
    }

    console.log('[gemini] 正在取消当前请求');
    this.currentProcess.kill();
    this.currentProcess = null;
    return true;
  }
}
