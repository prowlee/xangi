import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { RunOptions, RunResult, StreamCallbacks, AgentRunner } from './agent-runner.js';
import { mergeTexts, sanitizeSurrogates } from './agent-runner.js';
import { DEFAULT_TIMEOUT_MS } from './constants.js';
import { getSafeEnv } from './base-runner.js';
import { buildPersistentSystemPrompt } from './base-runner.js';
import type { ChatPlatform } from './prompts/index.js';
import { getGitHubEnv } from './github-auth.js';
import { logPrompt, logResponse, logError } from './transcript-logger.js';

/**
 * 请求队列项
 */
interface QueueItem {
  prompt: string;
  options?: RunOptions;
  callbacks?: StreamCallbacks;
  resolve: (result: RunResult) => void;
  reject: (error: Error) => void;
}

/**
 * 将 Claude Code CLI 作为常驻进程执行的运行器
 *
 * 使用 --input-format=stream-json 在单个进程中处理多个请求
 */
export class PersistentRunner extends EventEmitter implements AgentRunner {
  private process: ChildProcess | null = null;
  private processAlive = false;
  private queue: QueueItem[] = [];
  private currentItem: QueueItem | null = null;
  private buffer = '';
  private sessionId = '';
  private fullText = '';
  private shuttingDown = false;
  private cancelling = false;

  // 断路器：防止连续崩溃
  private crashCount = 0;
  private lastCrashTime = 0;
  private static readonly MAX_CRASHES = 3;
  private static readonly CRASH_WINDOW_MS = 60000; // 1分钟内崩溃3次则停止

  private model?: string;
  private timeoutMs: number;
  private workdir?: string;
  private skipPermissions: boolean;
  private systemPrompt: string;
  private resumeSessionId?: string; // 进程重启时使用 --resume 恢复的会话ID
  private channelId?: string; // 用于转录日志
  private appSessionId?: string; // xangi 侧的会话ID
  private effort?: string; // Claude Code 的 --effort 选项

  constructor(options?: {
    model?: string;
    timeoutMs?: number;
    workdir?: string;
    skipPermissions?: boolean;
    channelId?: string;
    platform?: ChatPlatform;
    effort?: string;
  }) {
    super();
    this.model = options?.model;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.workdir = options?.workdir;
    this.skipPermissions = options?.skipPermissions ?? false;
    this.systemPrompt = buildPersistentSystemPrompt(options?.platform);
    this.channelId = options?.channelId;
    this.effort = options?.effort;
  }

  /**
   * 设置 appSessionId（从外部调用）
   */
  setAppSessionId(appSessionId: string): void {
    this.appSessionId = appSessionId;
  }

  /**
   * 启动常驻进程
   */
  private ensureProcess(): ChildProcess {
    if (this.process && this.processAlive) {
      return this.process;
    }

    // 断路器检查
    if (this.crashCount >= PersistentRunner.MAX_CRASHES) {
      const elapsed = Date.now() - this.lastCrashTime;
      if (elapsed < PersistentRunner.CRASH_WINDOW_MS) {
        throw new Error(
          `断路器打开：${this.crashCount} 次崩溃发生在 ${elapsed}ms 内。请等待冷却。`
        );
      }
      // 冷却结束后重置（会话已清除，使用新会话启动）
      console.log(
        '[persistent-runner] 冷却后断路器已重置。使用新会话启动。'
      );
      this.crashCount = 0;
    }

    const args: string[] = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
    ];

    if (this.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    if (this.model) {
      args.push('--model', this.model);
    }

    if (this.effort) {
      args.push('--effort', this.effort);
    }

    // 会话恢复：如果有保存的会话ID，使用 --resume 继续
    const resumeId = this.resumeSessionId || this.sessionId;
    if (resumeId) {
      args.push('--resume', resumeId);
      console.log(`[persistent-runner] 恢复会话: ${resumeId.slice(0, 8)}...`);
    }

    args.push('--append-system-prompt', this.systemPrompt);

    console.log('[persistent-runner] 正在启动常驻进程...');

    this.process = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.workdir,
      env: { ...getSafeEnv(), ...getGitHubEnv(getSafeEnv()) },
    });
    this.processAlive = true;

    this.process.stdout?.on('data', (data) => this.handleOutput(data.toString()));
    this.process.stderr?.on('data', (data) => {
      console.error('[persistent-runner] stderr:', data.toString());
    });

    this.process.on('close', (code) => {
      console.log(`[persistent-runner] 进程退出，代码 ${code}`);
      const wasShuttingDown = this.shuttingDown;
      this.process = null;
      this.processAlive = false;
      this.buffer = ''; // 清空缓冲区

      // 正在关闭或取消中，视为正常结束
      if (wasShuttingDown) {
        return;
      }
      if (this.cancelling) {
        this.cancelling = false;
        // 如果队列中有下一个请求，继续处理
        if (this.queue.length > 0) {
          this.processNext();
        }
        return;
      }

      // 更新崩溃计数器
      this.crashCount++;
      this.lastCrashTime = Date.now();
      console.warn(
        `[persistent-runner] 崩溃次数: ${this.crashCount}/${PersistentRunner.MAX_CRASHES}`
      );

      // 如果有正在处理的请求，以错误结束
      if (this.currentItem) {
        this.currentItem.reject(new Error(`进程意外退出，代码 ${code}`));
        this.currentItem = null;
      }

      // 如果断路器未打开，重新处理队列
      if (this.queue.length > 0 && this.crashCount < PersistentRunner.MAX_CRASHES) {
        console.log('[persistent-runner] 为队列中的请求重启进程...');
        this.processNext();
      } else if (this.crashCount >= PersistentRunner.MAX_CRASHES) {
        // 断路器打开：销毁会话，下次请求时使用新会话启动
        console.error(
          '[persistent-runner] 断路器 OPEN。清除会话以便在下一次请求时恢复。'
        );
        const oldSessionId = this.sessionId || this.resumeSessionId;
        this.sessionId = '';
        this.resumeSessionId = undefined;
        this.emit('session-invalidated', this.channelId, oldSessionId);

        // 将队列中的所有项都标记为错误
        for (const item of this.queue) {
          item.reject(
            new Error(
              '断路器打开：进程崩溃次数过多。会话已清除以进行恢复。'
            )
          );
        }
        this.queue = [];
      }
    });

    this.process.on('error', (err) => {
      console.error('[persistent-runner] 进程错误:', err);
      this.process = null;
      this.processAlive = false;

      if (this.currentItem) {
        this.currentItem.reject(err);
        this.currentItem = null;
      }
    });

    return this.process;
  }

  /**
   * 处理 stdout 输出
   */
  private handleOutput(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const json = JSON.parse(line);
        this.handleJsonMessage(json);
      } catch (e) {
        // 记录意外的 CLI 输出（用于调试）
        console.warn('[persistent-runner] 解析 JSON 行失败:', line.slice(0, 100), e);
      }
    }
  }

  /**
   * 处理 JSON 消息
   */
  private handleJsonMessage(json: {
    type: string;
    session_id?: string;
    message?: {
      content?: Array<{
        type: string;
        text?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
    };
    result?: string;
    is_error?: boolean;
  }): void {
    if (json.type === 'system' && json.session_id) {
      this.sessionId = json.session_id;
      console.log(`[persistent-runner] 会话已初始化: ${this.sessionId.slice(0, 8)}...`);
    }

    if (json.type === 'assistant' && json.message?.content) {
      for (const block of json.message.content) {
        if (block.type === 'text' && block.text) {
          this.fullText += block.text;
          this.currentItem?.callbacks?.onText?.(block.text, this.fullText);
        }
        if (block.type === 'tool_use' && block.name) {
          this.currentItem?.callbacks?.onToolUse?.(block.name, block.input ?? {});
        }
      }
    }

    if (json.type === 'result') {
      if (json.session_id) {
        this.sessionId = json.session_id;
      }

      // 发送 providerSessionId（用于 sessions.ts 的后置保存）
      if (json.session_id) {
        this.emit('provider-session-id', json.session_id);
      }

      // 转录日志：记录最终结果
      const resultAppSessionId = this.currentItem?.options?.appSessionId || this.appSessionId;
      if (resultAppSessionId && this.workdir) {
        if (json.is_error) {
          logError(this.workdir, resultAppSessionId, json.result || '未知错误');
        } else {
          logResponse(this.workdir, resultAppSessionId, json as Record<string, unknown>);
        }
      }

      if (json.is_error) {
        // 如果使用 --resume 启动失败，很可能是会话已过期
        // 清除会话并重试（仅一次）
        const resumeId = this.resumeSessionId;
        if (resumeId) {
          console.warn(
            `[persistent-runner] 使用会话 ${resumeId.slice(0, 8)}... 恢复失败。清除过期会话并重试。`
          );
          const oldSessionId = resumeId;
          this.resumeSessionId = undefined;
          this.sessionId = '';
          this.emit('session-invalidated', this.channelId, oldSessionId);

          // 杀死进程，使用新会话重试
          if (this.process) {
            this.cancelling = true;
            this.process.kill();
            this.process = null;
            this.processAlive = false;
            this.buffer = '';
          }

          // 将当前请求放回队列头部重试
          if (this.currentItem) {
            this.queue.unshift(this.currentItem);
            this.currentItem = null;
          }
          this.fullText = '';

          // cancelling 标志将在 close 事件中清除，
          // 但为了防止进程尚未死亡，直接调用 processNext
          setTimeout(() => {
            this.cancelling = false;
            this.processNext();
          }, 100);
          return;
        }

        const error = new Error(json.result || '未知错误');
        this.currentItem?.callbacks?.onError?.(error);
        this.currentItem?.reject(error);
      } else {
        // 合并流式传输中的累积文本与最终 result
        // （防止工具调用前的文本从 result 中消失）
        if (json.result) {
          this.fullText = mergeTexts(this.fullText, json.result);
        }

        const result: RunResult = {
          result: this.fullText,
          sessionId: this.sessionId,
        };

        this.currentItem?.callbacks?.onComplete?.(result);
        this.currentItem?.resolve(result);
      }

      this.currentItem = null;
      this.fullText = '';

      // 处理下一个请求
      this.processNext();
    }
  }

  /**
   * 从队列中处理下一个请求
   */
  private processNext(): void {
    if (this.currentItem || this.queue.length === 0) {
      return;
    }

    this.currentItem = this.queue.shift()!;
    this.fullText = '';

    const proc = this.ensureProcess();

    // 添加会话延续选项
    const message = {
      type: 'user',
      message: {
        role: 'user',
        content: sanitizeSurrogates(this.currentItem.prompt),
      },
    };

    console.log(`[persistent-runner] 发送请求（队列剩余: ${this.queue.length}）`);

    // appSessionId 从请求的 options 中获取（/new 时会变化）
    const reqAppSessionId = this.currentItem.options?.appSessionId || this.appSessionId;

    // 转录日志：记录发送的提示词
    if (reqAppSessionId && this.workdir) {
      logPrompt(this.workdir, reqAppSessionId, this.currentItem.prompt);
    }

    proc.stdin?.write(JSON.stringify(message) + '\n');

    // 设置超时：超时时杀死进程并清理状态
    const timeout = setTimeout(() => {
      if (this.currentItem) {
        console.warn(
          `[persistent-runner] 请求在 ${this.timeoutMs}ms 后超时。正在杀死进程。`
        );
        const error = new Error(`请求在 ${this.timeoutMs}ms 后超时`);
        this.currentItem.callbacks?.onError?.(error);
        this.currentItem.reject(error);
        this.currentItem = null;

        // 超时时杀死进程，为下一个请求重启
        // 这可以防止旧请求的输出混入新请求
        if (this.process) {
          this.process.kill();
          this.process = null;
          this.processAlive = false;
          this.buffer = '';
        }

        this.processNext();
      }
    }, this.timeoutMs);

    // 包装 resolve/reject 以清除超时
    const originalResolve = this.currentItem.resolve;
    const originalReject = this.currentItem.reject;

    this.currentItem.resolve = (result) => {
      clearTimeout(timeout);
      originalResolve(result);
    };

    this.currentItem.reject = (error) => {
      clearTimeout(timeout);
      originalReject(error);
    };
  }

  /**
   * 执行请求（添加到队列）
   */
  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ prompt, options, resolve, reject });
      this.processNext();
    });
  }

  /**
   * 流式执行
   */
  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ prompt, options, callbacks, resolve, reject });
      this.processNext();
    });
  }

  /**
   * 取消当前正在处理的请求
   * 杀死进程本身并重启（防止旧输出混入）
   */
  cancel(): boolean {
    if (!this.currentItem) {
      return false;
    }

    console.log('[persistent-runner] 正在取消当前请求');
    const error = new Error('请求已被用户取消');
    this.currentItem.callbacks?.onError?.(error);
    this.currentItem.reject(error);
    this.currentItem = null;
    this.fullText = '';

    // 杀死进程以清理状态（与超时策略相同）
    // 使用 cancelling 标志防止 close 事件被视为崩溃
    if (this.process) {
      this.cancelling = true;
      this.process.kill();
      this.process = null;
      this.processAlive = false;
      this.buffer = '';
    } else {
      // 没有进程时，直接处理队列中的下一个
      this.processNext();
    }

    return true;
  }

  /**
   * 终止进程
   */
  shutdown(): void {
    if (this.process) {
      console.log('[persistent-runner] 正在关闭常驻进程...');
      this.shuttingDown = true;
      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
      this.processAlive = false;
      this.buffer = '';

      // 取消队列中剩余的请求
      for (const item of this.queue) {
        item.reject(new Error('运行器正在关闭'));
      }
      this.queue = [];

      if (this.currentItem) {
        this.currentItem.reject(new Error('运行器正在关闭'));
        this.currentItem = null;
      }
    }
  }

  /**
   * 获取当前会话ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * 设置会话ID（用于进程重启时的 --resume）
   */
  setSessionId(sessionId: string): void {
    this.resumeSessionId = sessionId;
    if (!this.sessionId) {
      this.sessionId = sessionId;
    }
  }

  /**
   * 获取队列长度
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * 检查进程是否存活
   */
  isAlive(): boolean {
    return this.processAlive;
  }

  /**
   * 获取断路器状态
   */
  getCircuitBreakerStatus(): { open: boolean; crashCount: number; lastCrashTime: number } {
    const open =
      this.crashCount >= PersistentRunner.MAX_CRASHES &&
      Date.now() - this.lastCrashTime < PersistentRunner.CRASH_WINDOW_MS;
    return { open, crashCount: this.crashCount, lastCrashTime: this.lastCrashTime };
  }

  /**
   * 重置断路器
   */
  resetCircuitBreaker(): void {
    this.crashCount = 0;
    this.lastCrashTime = 0;
    console.log('[persistent-runner] 断路器已手动重置');
  }
}
