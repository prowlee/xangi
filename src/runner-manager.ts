import { PersistentRunner } from './persistent-runner.js';
import type { AgentRunner, RunOptions, RunResult, StreamCallbacks } from './agent-runner.js';
import type { AgentConfig } from './config.js';
import type { ChatPlatform } from './prompts/index.js';
import { deleteSession } from './sessions.js';

/**
 * 池中的运行器信息
 */
interface PoolEntry {
  runner: PersistentRunner;
  lastUsed: number;
}

/**
 * 实现多频道同时处理的运行器管理器
 *
 * 为每个频道管理独立的 PersistentRunner，
 * 通过 LRU 淘汰和空闲超时来控制资源。
 */
export class RunnerManager implements AgentRunner {
  private pool = new Map<string, PoolEntry>();
  private maxProcesses: number;
  private idleTimeoutMs: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private agentConfig: AgentConfig;
  private platform?: ChatPlatform;
  private effort?: string;

  /** 默认频道 ID（未指定 channelId 时使用） */
  private static readonly DEFAULT_CHANNEL = '__default__';
  /** 清理执行间隔 */
  private static readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5分钟

  constructor(
    agentConfig: AgentConfig,
    options?: {
      maxProcesses?: number;
      idleTimeoutMs?: number;
      platform?: ChatPlatform;
      effort?: string;
    }
  ) {
    this.agentConfig = agentConfig;
    this.platform = options?.platform;
    this.effort = options?.effort;
    this.maxProcesses = options?.maxProcesses ?? 10;
    this.idleTimeoutMs = options?.idleTimeoutMs ?? 30 * 60 * 1000; // 30分钟

    // 开始定期清理
    this.cleanupInterval = setInterval(() => this.cleanupIdle(), RunnerManager.CLEANUP_INTERVAL_MS);

    console.log(
      `[runner-manager] 已初始化 (最大进程数: ${this.maxProcesses}, 空闲超时: ${this.idleTimeoutMs / 1000}秒)`
    );
  }

  /**
   * 获取频道对应的 PersistentRunner（不存在则创建）
   */
  private getOrCreateRunner(channelId: string): PersistentRunner {
    const entry = this.pool.get(channelId);
    if (entry) {
      entry.lastUsed = Date.now();
      return entry.runner;
    }

    // 上限检查 → LRU 淘汰
    if (this.pool.size >= this.maxProcesses) {
      this.evictLRU();
    }

    // 创建新的 PersistentRunner
    // web-chat 频道使用 Web 专用的系统提示词
    const runnerPlatform = channelId === 'web-chat' ? ('web' as const) : this.platform;
    const runner = new PersistentRunner({
      ...this.agentConfig,
      channelId,
      platform: runnerPlatform,
      effort: this.effort,
    });

    // 会话失效事件：也从 sessions.json 中删除，实现永久重置
    runner.on('session-invalidated', (ch: string, oldSessionId: string) => {
      if (ch) {
        deleteSession(ch);
        console.log(
          `[runner-manager] 频道 ${ch} 的会话已失效（原会话: ${oldSessionId?.slice(0, 8) ?? '无'}）。已从 sessions.json 中删除。`
        );
      }
    });

    this.pool.set(channelId, {
      runner,
      lastUsed: Date.now(),
    });

    console.log(
      `[runner-manager] 为频道 ${channelId} 创建了运行器 (池: ${this.pool.size}/${this.maxProcesses})`
    );

    return runner;
  }

  /**
   * 淘汰最久未使用（LRU）的运行器
   */
  private evictLRU(): void {
    let oldestChannel: string | null = null;
    let oldestTime = Infinity;

    for (const [channelId, entry] of this.pool.entries()) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldestChannel = channelId;
      }
    }

    if (oldestChannel) {
      const entry = this.pool.get(oldestChannel)!;
      console.log(
        `[runner-manager] 淘汰频道 ${oldestChannel} 的 LRU 运行器 (空闲 ${Math.round((Date.now() - entry.lastUsed) / 1000)}秒)`
      );
      entry.runner.shutdown();
      this.pool.delete(oldestChannel);
    }
  }

  /**
   * 清理空闲的运行器
   */
  private cleanupIdle(): void {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [channelId, entry] of this.pool.entries()) {
      if (now - entry.lastUsed > this.idleTimeoutMs) {
        toRemove.push(channelId);
      }
    }

    for (const channelId of toRemove) {
      const entry = this.pool.get(channelId)!;
      console.log(
        `[runner-manager] 清理频道 ${channelId} 的空闲运行器 (空闲 ${Math.round((now - entry.lastUsed) / 1000)}秒)`
      );
      entry.runner.shutdown();
      this.pool.delete(channelId);
    }

    if (toRemove.length > 0) {
      console.log(
        `[runner-manager] 已清理 ${toRemove.length} 个空闲运行器 (池: ${this.pool.size}/${this.maxProcesses})`
      );
    }
  }

  /**
   * 执行请求
   */
  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    const channelId = options?.channelId ?? RunnerManager.DEFAULT_CHANNEL;
    const runner = this.getOrCreateRunner(channelId);
    // 如果传入了会话ID，则设置到运行器中（用于进程重启时的恢复）
    if (options?.sessionId) {
      runner.setSessionId(options.sessionId);
    }
    return runner.run(prompt, options);
  }

  /**
   * 流式执行
   */
  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    const channelId = options?.channelId ?? RunnerManager.DEFAULT_CHANNEL;
    const runner = this.getOrCreateRunner(channelId);
    // 如果传入了会话ID，则设置到运行器中（用于进程重启时的恢复）
    if (options?.sessionId) {
      runner.setSessionId(options.sessionId);
    }
    return runner.runStream(prompt, callbacks, options);
  }

  /**
   * 取消指定频道的请求
   * 如果没有指定 channelId，则尝试所有频道
   */
  cancel(channelId?: string): boolean {
    if (channelId) {
      const entry = this.pool.get(channelId);
      if (entry) {
        return entry.runner.cancel();
      }
      return false;
    }

    // 未指定 channelId：尝试所有运行器
    for (const entry of this.pool.values()) {
      if (entry.runner.cancel()) {
        return true;
      }
    }
    return false;
  }

  /**
   * 完全销毁指定频道的运行器（用于 /new）
   */
  destroy(channelId: string): boolean {
    const entry = this.pool.get(channelId);
    if (entry) {
      entry.runner.shutdown();
      this.pool.delete(channelId);
      console.log(
        `[runner-manager] 已销毁频道 ${channelId} 的运行器 (池: ${this.pool.size}/${this.maxProcesses})`
      );
      return true;
    }
    return false;
  }

  /**
   * 关闭所有运行器
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    for (const [channelId, entry] of this.pool.entries()) {
      console.log(`[runner-manager] 正在关闭频道 ${channelId} 的运行器`);
      entry.runner.shutdown();
    }
    this.pool.clear();
    console.log('[runner-manager] 所有运行器已关闭');
  }

  /**
   * 获取池状态（用于调试和状态显示）
   */
  getStatus(): {
    poolSize: number;
    maxProcesses: number;
    channels: Array<{ channelId: string; idleSeconds: number; alive: boolean }>;
  } {
    const now = Date.now();
    const channels = Array.from(this.pool.entries()).map(([channelId, entry]) => ({
      channelId,
      idleSeconds: Math.round((now - entry.lastUsed) / 1000),
      alive: entry.runner.isAlive(),
    }));

    return {
      poolSize: this.pool.size,
      maxProcesses: this.maxProcesses,
      channels,
    };
  }
}
