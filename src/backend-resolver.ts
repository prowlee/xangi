import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { AgentBackend, Config, EffortLevel } from './config.js';
import { getBackendDisplayName } from './agent-runner.js';

/**
 * 每个频道的覆盖设置
 */
export interface ChannelOverride {
  backend?: AgentBackend;
  model?: string;
  effort?: EffortLevel;
}

/**
 * 每个频道解析后的后端设置
 */
export interface ResolvedBackend {
  backend: AgentBackend;
  model?: string;
  effort?: EffortLevel;
}

/**
 * 解析每个频道的后端、模型、effort
 *
 * 优先级:
 * 1. 通过 /model set 设置的内存覆盖
 * 2. CHANNEL_OVERRIDES 环境变量（通过 .env 持久化）
 * 3. .env 的默认值（AGENT_BACKEND, AGENT_MODEL）
 *
 * channelOverrides 在内存中管理。
 * 初始值从 CHANNEL_OVERRIDES 环境变量读取。
 * 在 Docker 环境中，由于 .env 文件在容器内不存在，
 * 无需担心被 AI 修改。
 */
export class BackendResolver {
  private defaultBackend: AgentBackend;
  private defaultModel?: string;
  private allowedBackends?: AgentBackend[];
  private allowedModels?: string[];

  /** 内存中的频道覆盖 */
  private channelOverrides: Map<string, ChannelOverride>;
  /** .env 文件路径（用于持久化） */
  private envFilePath?: string;

  constructor(config: Config) {
    this.defaultBackend = config.agent.backend;
    this.defaultModel = config.agent.config.model;
    this.allowedBackends = config.agent.allowedBackends;
    this.allowedModels = config.agent.allowedModels;

    // 从 CHANNEL_OVERRIDES 环境变量读取初始值
    this.channelOverrides = new Map();
    const envOverrides = process.env.CHANNEL_OVERRIDES;
    if (envOverrides) {
      try {
        const parsed = JSON.parse(envOverrides) as Record<string, ChannelOverride>;
        for (const [channelId, override] of Object.entries(parsed)) {
          this.channelOverrides.set(channelId, override);
        }
        console.log(
          `[backend-resolver] Loaded ${this.channelOverrides.size} channel override(s) from CHANNEL_OVERRIDES`
        );
      } catch (e) {
        console.error('[backend-resolver] Failed to parse CHANNEL_OVERRIDES:', e);
      }
    }

    // 检测 .env 文件路径（用于持久化）
    // 如果 xangi 的启动目录中有 .env 则使用它
    try {
      const candidatePath = join(process.cwd(), '.env');
      readFileSync(candidatePath, 'utf-8');
      this.envFilePath = candidatePath;
    } catch {
      // 未找到 .env 则不持久化（Docker 环境等）
    }
  }

  /**
   * 解析指定频道的后端设置
   */
  resolve(channelId?: string): ResolvedBackend {
    if (!channelId) {
      return {
        backend: this.defaultBackend,
        model: this.defaultModel,
      };
    }

    const override = this.channelOverrides.get(channelId);
    if (!override) {
      return {
        backend: this.defaultBackend,
        model: this.defaultModel,
      };
    }

    return {
      backend: override.backend ?? this.defaultBackend,
      model: override.model ?? (override.backend ? undefined : this.defaultModel),
      effort: override.effort,
    };
  }

  /**
   * 设置频道覆盖，并持久化到 .env
   */
  setChannelOverride(channelId: string, override: ChannelOverride): void {
    this.channelOverrides.set(channelId, override);
    this.persistToEnv();
    console.log(
      `[backend-resolver] Set override for ${channelId}: ${getBackendDisplayName(override.backend ?? this.defaultBackend)}` +
        (override.model ? ` (${override.model})` : '') +
        (override.effort ? ` effort=${override.effort}` : '')
    );
  }

  /**
   * 删除频道覆盖，并持久化到 .env
   */
  deleteChannelOverride(channelId: string): boolean {
    const had = this.channelOverrides.delete(channelId);
    if (had) {
      this.persistToEnv();
      console.log(`[backend-resolver] Deleted override for ${channelId}`);
    }
    return had;
  }

  /**
   * 将当前的 channelOverrides 持久化到 .env 的 CHANNEL_OVERRIDES
   */
  private persistToEnv(): void {
    if (!this.envFilePath) return;

    try {
      let envContent = readFileSync(this.envFilePath, 'utf-8');
      const overridesObj: Record<string, ChannelOverride> = {};
      for (const [k, v] of this.channelOverrides) {
        overridesObj[k] = v;
      }

      const newValue = Object.keys(overridesObj).length > 0 ? JSON.stringify(overridesObj) : '';
      const line = newValue ? `CHANNEL_OVERRIDES=${newValue}` : '';

      if (envContent.includes('CHANNEL_OVERRIDES=')) {
        // 替换现有行
        envContent = envContent.replace(/^CHANNEL_OVERRIDES=.*$/m, line);
        // 如果变成空行则删除
        if (!line) {
          envContent = envContent.replace(/\n\n+/g, '\n\n');
        }
      } else if (line) {
        // 新增
        envContent = envContent.trimEnd() + '\n\n' + line + '\n';
      }

      writeFileSync(this.envFilePath, envContent, 'utf-8');
      console.log(`[backend-resolver] Persisted CHANNEL_OVERRIDES to .env`);
    } catch (e) {
      console.warn('[backend-resolver] Failed to persist to .env:', e);
    }
  }

  /**
   * 获取频道覆盖
   */
  getChannelOverride(channelId: string): ChannelOverride | undefined {
    return this.channelOverrides.get(channelId);
  }

  /**
   * 后端是否在允许列表中
   * 未设置 ALLOWED_BACKENDS 时返回 false（不可切换）
   */
  isBackendAllowed(backend: AgentBackend): boolean {
    if (!this.allowedBackends) return false;
    return this.allowedBackends.includes(backend);
  }

  /**
   * 模型是否在允许列表中
   * 未设置 ALLOWED_MODELS 时返回 true（无限制）
   */
  isModelAllowed(model: string): boolean {
    if (!this.allowedModels) return true;
    return this.allowedModels.includes(model);
  }

  /**
   * 获取默认后端
   */
  getDefault(): ResolvedBackend {
    return {
      backend: this.defaultBackend,
      model: this.defaultModel,
    };
  }

  /**
   * 允许的后端列表
   * 未设置时仅包含默认后端
   */
  getAllowedBackends(): AgentBackend[] {
    return this.allowedBackends ?? [this.defaultBackend];
  }

  /**
   * 允许的模型列表（undefined = 无限制）
   */
  getAllowedModels(): string[] | undefined {
    return this.allowedModels;
  }

  /**
   * 获取当前频道覆盖列表（用于显示）
   */
  getChannelOverrides(): Map<string, ChannelOverride> {
    return new Map(this.channelOverrides);
  }
}
