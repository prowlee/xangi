/**
 * 动态切换每个频道后端的运行管理器
 *
 * 基于 BackendResolver 解析出的后端设置，
 * 将请求路由到适当的 AgentRunner。
 *
 * - claude-code (持久化模式): 由 RunnerManager 管理（按频道进程）
 * - claude-code (非持久化模式): 共享的 ClaudeCodeRunner
 * - codex / gemini / local-llm: 按后端类型的共享实例
 */
export class DynamicRunnerManager implements AgentRunner {
  private resolver: BackendResolver;
  private config: Config;
  private platform?: ChatPlatform;

  /** 默认运行器（基于 .env 设置） */
  private defaultRunner: AgentRunner;

  /** 按频道生成的运行器（当后端与默认不同时） */
  private channelRunners = new Map<string, { runner: AgentRunner; key: string }>();

  constructor(config: Config, resolver: BackendResolver) {
    this.config = config;
    this.resolver = resolver;
    this.platform = config.agent.platform;

    // 创建默认运行器
    this.defaultRunner = createAgentRunner(config.agent.backend, config.agent.config, {
      platform: this.platform,
    });

    console.log(
      `[dynamic-runner] 已初始化，默认后端：${getBackendDisplayName(config.agent.backend)}`
    );
  }

  /**
   * 获取频道对应的运行器
   * 如果 resolvedBackend 与默认相同，则返回默认运行器
   */
  private getRunner(channelId: string | undefined, resolved: ResolvedBackend): AgentRunner {
    if (!channelId) return this.defaultRunner;

    // 如果与默认相同，则使用共享运行器
    const resolverKey = this.makeKey(resolved);
    const defaultKey = this.makeKey(this.resolver.getDefault());

    if (resolverKey === defaultKey && !resolved.effort) {
      // 如果有频道的专用运行器，则销毁它
      this.destroyChannelRunner(channelId);
      return this.defaultRunner;
    }

    // 如果已存在频道运行器且键匹配，则使用它
    const existing = this.channelRunners.get(channelId);
    if (existing && existing.key === resolverKey + (resolved.effort ?? '')) {
      return existing.runner;
    }

    // 销毁已存在的频道运行器
    this.destroyChannelRunner(channelId);

    // 创建新的运行器
    const runner = this.createRunnerFor(resolved, channelId);
    this.channelRunners.set(channelId, {
      runner,
      key: resolverKey + (resolved.effort ?? ''),
    });

    console.log(
      `[dynamic-runner] 为频道 ${channelId} 创建运行器：${getBackendDisplayName(resolved.backend)}` +
        (resolved.model ? ` (${resolved.model})` : '') +
        (resolved.effort ? ` effort=${resolved.effort}` : '')
    );

    return runner;
  }

  /**
   * 从 ResolvedBackend 创建适当的运行器
   */
  private createRunnerFor(resolved: ResolvedBackend, _channelId?: string): AgentRunner {
    const agentConfig: AgentConfig = {
      ...this.config.agent.config,
      model: resolved.model ?? this.config.agent.config.model,
    };

    // claude-code 持久化模式：创建带 effort 的专用 RunnerManager
    if (resolved.backend === 'claude-code' && agentConfig.persistent) {
      return new RunnerManager(agentConfig, {
        maxProcesses: agentConfig.maxProcesses,
        idleTimeoutMs: agentConfig.idleTimeoutMs,
        platform: this.platform,
        effort: resolved.effort,
      });
    }

    return createAgentRunner(resolved.backend, agentConfig, {
      platform: this.platform,
    });
  }

  private makeKey(resolved: ResolvedBackend): string {
    return `${resolved.backend}:${resolved.model ?? 'default'}`;
  }

  private destroyChannelRunner(channelId: string): void {
    const existing = this.channelRunners.get(channelId);
    if (existing) {
      existing.runner.destroy?.(channelId);
      // 如果是 RunnerManager，也调用 shutdown
      if (
        'shutdown' in existing.runner &&
        typeof (existing.runner as RunnerManager).shutdown === 'function'
      ) {
        (existing.runner as RunnerManager).shutdown();
      }
      this.channelRunners.delete(channelId);
      console.log(`[dynamic-runner] 已销毁频道 ${channelId} 的运行器`);
    }
  }

  /**
   * 执行请求
   */
  async run(prompt: string, options?: RunOptions): Promise<RunResult> {
    const channelId = options?.channelId;
    const resolved = this.resolver.resolve(channelId);
    const runner = this.getRunner(channelId, resolved);

    // 将 effort 注入选项（用于 per-request 类型的 claude-code）
    const runOptions = resolved.effort ? { ...options, effort: resolved.effort } : options;

    return runner.run(prompt, runOptions);
  }

  /**
   * 流式执行
   */
  async runStream(
    prompt: string,
    callbacks: StreamCallbacks,
    options?: RunOptions
  ): Promise<RunResult> {
    const channelId = options?.channelId;
    const resolved = this.resolver.resolve(channelId);
    const runner = this.getRunner(channelId, resolved);

    const runOptions = resolved.effort ? { ...options, effort: resolved.effort } : options;

    return runner.runStream(prompt, callbacks, runOptions);
  }

  /**
   * 取消
   */
  cancel(channelId?: string): boolean {
    if (channelId) {
      const channelEntry = this.channelRunners.get(channelId);
      if (channelEntry?.runner.cancel) {
        return channelEntry.runner.cancel(channelId);
      }
    }
    return this.defaultRunner.cancel?.(channelId) ?? false;
  }

  /**
   * 销毁指定频道的运行器
   */
  destroy(channelId: string): boolean {
    // 如果有频道专用运行器则销毁
    const hadChannelRunner = this.channelRunners.has(channelId);
    this.destroyChannelRunner(channelId);

    // 也调用默认运行器的 destroy（删除 RunnerManager 池中的条目）
    const defaultDestroyed = this.defaultRunner.destroy?.(channelId) ?? false;

    return hadChannelRunner || defaultDestroyed;
  }

  /**
   * 切换后端
   * 删除会话并销毁运行器，下次请求时创建新的运行器
   */
  switchBackend(channelId: string): void {
    deleteSession(channelId);
    this.destroyChannelRunner(channelId);
    this.defaultRunner.destroy?.(channelId);
    console.log(`[dynamic-runner] 已为频道 ${channelId} 切换后端`);
  }

  /**
   * 获取频道当前的后端设置
   */
  resolveForChannel(channelId?: string): ResolvedBackend {
    return this.resolver.resolve(channelId);
  }

  /**
   * 获取池状态（用于调试和状态显示）
   */
  getStatus(): {
    defaultBackend: string;
    channelRunners: Array<{ channelId: string; key: string }>;
    defaultRunnerStatus?: ReturnType<RunnerManager['getStatus']>;
  } {
    const channelInfo = Array.from(this.channelRunners.entries()).map(([channelId, entry]) => ({
      channelId,
      key: entry.key,
    }));

    return {
      defaultBackend: getBackendDisplayName(this.config.agent.backend),
      channelRunners: channelInfo,
      defaultRunnerStatus:
        'getStatus' in this.defaultRunner
          ? (this.defaultRunner as RunnerManager).getStatus()
          : undefined,
    };
  }

  /**
   * 关闭所有运行器
   */
  shutdown(): void {
    for (const [channelId, entry] of this.channelRunners.entries()) {
      entry.runner.destroy?.(channelId);
      if (
        'shutdown' in entry.runner &&
        typeof (entry.runner as RunnerManager).shutdown === 'function'
      ) {
        (entry.runner as RunnerManager).shutdown();
      }
    }
    this.channelRunners.clear();

    if (
      'shutdown' in this.defaultRunner &&
      typeof (this.defaultRunner as RunnerManager).shutdown === 'function'
    ) {
      (this.defaultRunner as RunnerManager).shutdown();
    }
  }
}
