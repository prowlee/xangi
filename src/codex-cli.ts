import { spawn, ChildProcess } from 'child_process';
import { processManager } from './process-manager.js';
import type { AgentRunner, RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';
import { DEFAULT_TIMEOUT_MS } from './constants.js';
import { buildSystemPrompt, getSafeEnv } from './base-runner.js';
import { getGitHubEnv } from './github-auth.js';
import { logPrompt, logResponse } from './transcript-logger.js';

export interface CodexOptions {
  model?: string;
  timeoutMs?: number;
  workdir?: string;
  skipPermissions?: boolean;
}

/**
 * Codex CLI 0.98.0 的 JSONL 事件类型定义
 */
interface CodexEvent {
  type: string;
  thread_id?: string;
  session_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
  // 回退用
  content?: string;
  result?: string;
}

/**
 * 执行 Codex CLI 的运行器（0.98.0 兼容）
 */
export class CodexRunner implements AgentRunner {
  private model?: string;
  private timeoutMs: number;
  private workdir?: string;
  private skipPermissions: boolean;
  private systemPrompt: string;
  private currentProcess: ChildProcess | null = null;

  constructor(options?: CodexOptions) {
    this.model = options?.model;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.workdir = options?.workdir;
    this.skipPermissions = options?.skipPermissions ?? false;
    this.systemPrompt = buildSystemPrompt();
  }

  /**
   * 构建命令参数（run/runStream 共用）
   */
  private buildArgs(prompt: string, options?: RunOptions): string[] {
    const args: string[] = ['exec', '--json'];

    const skip = options?.skipPermissions ?? this.skipPermissions;
    if (skip) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      args.push('--full-auto');
    }

    // 允许在 git 仓库外运行
    args.push('--skip-git-repo-check');

    if (this.model) {
      args.push('--model', this.model);
    }

    if (this.workdir) {
      args.push('--cd', this.workdir);
    }

    // 继续会话（--cd、--model 等选项需要放在 resume 子命令之前）
    if (options?.sessionId) {
      args.push('resume', options.sessionId);
    }

    // 将系统提示词注入到提示词中
    const fullPrompt = this.systemPrompt
      ? `<system-context>\n${this.systemPrompt}\n</system-context>\n\n${prompt}`
      : prompt;

    args.push(fullPrompt);

    return args;
  }

  /**
   * 从 JSONL 行中提取会话 ID
   */
  private extractSessionId(json: CodexEvent): string | undefined {
    // Codex 0.98.0 在 thread.started 事件中返回 thread_id
    if (json.type === 'thread.started' && json.thread_id) {
      return json.thread_id;
    }
    // 回退
    if (json.thread_id) return json.thread_id;
    if (json.session_id) return json.session_id;
    return undefined;
  }

  /**
   * 从 JSONL 行中提取文本
   */
  private extractText(json: CodexEvent): { text: string; isComplete: boolean } | null {
    // agent_message 完成 — 最终的回答文本
    if (json.type === 'item.completed' && json.item?.type === 'agent_message' && json.item.text) {
      return { text: json.item.text, isComplete: true };
    }
    // 回退: message 事件
    if (json.type === 'message' && json.content) {
      return { text: json.content, isComplete: true };
    }
    // 回退: result 字段
    if (json.result) {
      return { text: json.result, isComplete: true };
    }
    return null;
  }

  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    const args = this.buildArgs(prompt, options);

    const sessionInfo = options?.sessionId
      ? ` (session: ${options.sessionId.slice(0, 8)}...)`
      : ' (new)';
    console.log(`[codex] Executing in ${this.workdir || 'default dir'}${sessionInfo}`);

    // 记录日志: 记录发送的提示词
    if (options?.appSessionId && this.workdir) {
      logPrompt(this.workdir, options.appSessionId, prompt);
    }

    const { stdout, sessionId } = await this.execute(args, options?.channelId);
    const result = this.extractResult(stdout);

    // 记录日志: 记录响应
    if (options?.appSessionId && this.workdir) {
      logResponse(this.workdir, options.appSessionId, { result, sessionId });
    }

    return { result, sessionId };
  }

  private execute(
    args: string[],
    channelId?: string
  ): Promise<{ stdout: string; sessionId: string }> {
    const safeEnv = getSafeEnv();
    return new Promise((resolve, reject) => {
      const childEnv = { ...safeEnv, ...getGitHubEnv(safeEnv) };
      if (channelId) {
        childEnv.XANGI_CHANNEL_ID = channelId;
      }
      const proc = spawn('codex', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.workdir,
        env: childEnv,
      });
      this.currentProcess = proc;

      if (channelId) {
        processManager.register(channelId, proc);
      }

      let stdout = '';
      let stderr = '';
      let sessionId = '';

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;

        const lines = chunk.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line) as CodexEvent;
            const sid = this.extractSessionId(json);
            if (sid) sessionId = sid;
          } catch {
            // 忽略 JSON 解析错误
          }
        }
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill();
        this.currentProcess = null;
        reject(new Error(`Codex CLI timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        this.currentProcess = null;

        if (code !== 0) {
          reject(new Error(`Codex CLI exited with code ${code}: ${stderr}`));
          return;
        }

        resolve({ stdout, sessionId });
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        this.currentProcess = null;
        reject(new Error(`Failed to spawn Codex CLI: ${err.message}`));
      });
    });
  }

  private extractResult(output: string): string {
    const lines = output.trim().split('\n');
    const messageParts: string[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line) as CodexEvent;
        const extracted = this.extractText(json);
        if (extracted) {
          if (extracted.isComplete) {
            messageParts.push(extracted.text);
          }
        }
      } catch {
        // 忽略 JSON 解析错误
      }
    }

    // 使用最后一个 agent_message（多轮对话的情况）
    return messageParts.length > 0 ? messageParts[messageParts.length - 1] : output;
  }

  /**
   * 流式执行
   */
  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    const args = this.buildArgs(prompt, options);

    const sessionInfo = options?.sessionId
      ? ` (session: ${options.sessionId.slice(0, 8)}...)`
      : ' (new)';
    console.log(`[codex] Streaming in ${this.workdir || 'default dir'}${sessionInfo}`);

    // 记录日志: 记录发送的提示词
    if (options?.appSessionId && this.workdir) {
      logPrompt(this.workdir, options.appSessionId, prompt);
    }

    return this.executeStream(args, callbacks, options?.channelId, options?.appSessionId);
  }

  private executeStream(
    args: string[],
    callbacks: StreamCallbacks,
    channelId?: string,
    appSessionId?: string
  ): Promise<RunResult> {
    const safeEnv = getSafeEnv();
    return new Promise((resolve, reject) => {
      const childEnv = { ...safeEnv, ...getGitHubEnv(safeEnv) };
      if (channelId) {
        childEnv.XANGI_CHANNEL_ID = channelId;
      }
      const proc = spawn('codex', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.workdir,
        env: childEnv,
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
            const json = JSON.parse(line) as CodexEvent;

            // 提取会话 ID
            const sid = this.extractSessionId(json);
            if (sid) sessionId = sid;

            // 提取文本
            const extracted = this.extractText(json);
            if (extracted) {
              fullText = extracted.text;
              callbacks.onText?.(extracted.text, fullText);
            }

            // 记录 token 使用量
            if (json.type === 'turn.completed' && json.usage) {
              console.log(
                `[codex] Usage: input=${json.usage.input_tokens} (cached=${json.usage.cached_input_tokens ?? 0}), output=${json.usage.output_tokens}`
              );
            }
          } catch {
            // 忽略 JSON 解析错误
          }
        }
      });

      proc.stderr.on('data', (data) => {
        console.error('[codex] stderr:', data.toString());
      });

      const timeout = setTimeout(() => {
        proc.kill();
        this.currentProcess = null;
        const error = new Error(`Codex CLI timed out after ${this.timeoutMs}ms`);
        callbacks.onError?.(error);
        reject(error);
      }, this.timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        this.currentProcess = null;

        // 处理剩余的缓冲区
        if (buffer.trim()) {
          try {
            const json = JSON.parse(buffer) as CodexEvent;
            const sid = this.extractSessionId(json);
            if (sid) sessionId = sid;
            const extracted = this.extractText(json);
            if (extracted) {
              fullText = extracted.text;
            }
          } catch {
            // 忽略 JSON 解析错误
          }
        }

        if (code !== 0) {
          const error = new Error(`Codex CLI exited with code ${code}`);
          callbacks.onError?.(error);
          reject(error);
          return;
        }

        const result: RunResult = { result: fullText, sessionId };

        // 记录日志: 记录响应
        if (appSessionId && this.workdir) {
          logResponse(this.workdir, appSessionId, { result: fullText, sessionId });
        }

        callbacks.onComplete?.(result);
        resolve(result);
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        this.currentProcess = null;
        const error = new Error(`Failed to spawn Codex CLI: ${err.message}`);
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

    console.log('[codex] Cancelling current request');
    this.currentProcess.kill();
    this.currentProcess = null;
    return true;
  }
}
