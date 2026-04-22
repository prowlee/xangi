import { DEFAULT_TIMEOUT_MS } from './constants.js';
import type { ChatPlatform } from './prompts/index.js';

export type AgentBackend = 'claude-code' | 'codex' | 'gemini' | 'local-llm';

export interface AgentConfig {
  model?: string;
  timeoutMs?: number;
  workdir?: string;
  skipPermissions?: boolean;
  /** 常驻进程模式（高速化） */
  persistent?: boolean;
  /** 同时执行进程数的上限（用于 RunnerManager） */
  maxProcesses?: number;
  /** 空闲超时时间（毫秒，用于 RunnerManager） */
  idleTimeoutMs?: number;
}

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

export interface Config {
  discord: {
    enabled: boolean;
    token: string;
    allowedUsers?: string[];
    autoReplyChannels?: string[];
    streaming?: boolean;
    showThinking?: boolean;
    injectChannelTopic?: boolean;
    injectTimestamp?: boolean;
    showButtons?: boolean;
  };
  slack: {
    enabled: boolean;
    botToken?: string;
    appToken?: string;
    allowedUsers?: string[];
    autoReplyChannels?: string[];
    replyInThread?: boolean;
    streaming?: boolean;
    showThinking?: boolean;
  };
  agent: {
    backend: AgentBackend;
    config: AgentConfig;
    platform?: ChatPlatform;
    /** 允许切换的后端列表（未设置=全部允许） */
    allowedBackends?: AgentBackend[];
    /** 允许切换的模型列表（未设置=全部允许） */
    allowedModels?: string[];
  };
  scheduler: {
    enabled: boolean;
    startupEnabled: boolean;
  };
  // 为保持向后兼容性而保留
  claudeCode: AgentConfig;
}

export function loadConfig(): Config {
  const discordToken = process.env.DISCORD_TOKEN;
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  const slackAppToken = process.env.SLACK_APP_TOKEN;

  // 至少需要启用其中一个（仅 WebChat 也可以）
  const webChatEnabled = process.env.WEB_CHAT_ENABLED === 'true';
  if (!discordToken && !slackBotToken && !webChatEnabled) {
    throw new Error(
      'DISCORD_TOKEN, SLACK_BOT_TOKEN, or WEB_CHAT_ENABLED=true environment variable is required'
    );
  }

  const discordAllowedUser = process.env.DISCORD_ALLOWED_USER;
  const slackAllowedUser = process.env.SLACK_ALLOWED_USER;
  const discordAllowedUsers = discordAllowedUser
    ? discordAllowedUser
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const slackAllowedUsers = slackAllowedUser
    ? slackAllowedUser
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const backend = (process.env.AGENT_BACKEND || 'claude-code') as AgentBackend;
  if (
    backend !== 'claude-code' &&
    backend !== 'codex' &&
    backend !== 'gemini' &&
    backend !== 'local-llm'
  ) {
    throw new Error(
      `Invalid AGENT_BACKEND: ${backend}. Must be 'claude-code', 'codex', 'gemini', or 'local-llm'`
    );
  }

  // 自动检测平台
  const discordEnabled = !!discordToken;
  const slackEnabled = !!slackBotToken && !!slackAppToken;
  let platform: ChatPlatform | undefined;
  if (discordEnabled && !slackEnabled) {
    platform = 'discord';
  } else if (slackEnabled && !discordEnabled) {
    platform = 'slack';
  }
  // 两者都启用 → undefined（注入所有命令）

  const agentConfig: AgentConfig = {
    model: process.env.AGENT_MODEL || undefined,
    timeoutMs: process.env.TIMEOUT_MS ? parseInt(process.env.TIMEOUT_MS, 10) : DEFAULT_TIMEOUT_MS,
    workdir: process.env.WORKSPACE_PATH || undefined,
    skipPermissions: process.env.SKIP_PERMISSIONS === 'true',
    persistent: process.env.PERSISTENT_MODE !== 'false', // 默认启用
    maxProcesses: process.env.MAX_PROCESSES ? parseInt(process.env.MAX_PROCESSES, 10) : 10,
    idleTimeoutMs: process.env.IDLE_TIMEOUT_MS
      ? parseInt(process.env.IDLE_TIMEOUT_MS, 10)
      : 30 * 60 * 1000, // 30分钟
  };

  // 解析 ALLOWED_BACKENDS / ALLOWED_MODELS
  const allowedBackendsRaw = process.env.ALLOWED_BACKENDS;
  const allowedBackends: AgentBackend[] | undefined = allowedBackendsRaw
    ? (allowedBackendsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean) as AgentBackend[])
    : undefined;

  const allowedModelsRaw = process.env.ALLOWED_MODELS;
  const allowedModels: string[] | undefined = allowedModelsRaw
    ? allowedModelsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  return {
    discord: {
      enabled: !!discordToken,
      token: discordToken || '',
      allowedUsers: discordAllowedUsers,
      autoReplyChannels:
        process.env.AUTO_REPLY_CHANNELS?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) || [],
      streaming: process.env.DISCORD_STREAMING !== 'false',
      showThinking: process.env.DISCORD_SHOW_THINKING !== 'false',
      injectChannelTopic: process.env.INJECT_CHANNEL_TOPIC !== 'false', // 默认开启
      injectTimestamp: process.env.INJECT_TIMESTAMP !== 'false', // 默认开启
      showButtons: process.env.DISCORD_SHOW_BUTTONS !== 'false', // 默认开启
    },
    slack: {
      enabled: !!slackBotToken && !!slackAppToken,
      botToken: slackBotToken,
      appToken: slackAppToken,
      allowedUsers: slackAllowedUsers,
      autoReplyChannels:
        process.env.SLACK_AUTO_REPLY_CHANNELS?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) || [],
      replyInThread: process.env.SLACK_REPLY_IN_THREAD !== 'false',
      streaming: process.env.SLACK_STREAMING !== 'false',
      showThinking: process.env.SLACK_SHOW_THINKING !== 'false',
    },
    agent: {
      backend,
      config: agentConfig,
      platform,
      allowedBackends,
      allowedModels,
    },
    scheduler: {
      enabled: process.env.SCHEDULER_ENABLED !== 'false', // 默认启用
      startupEnabled: process.env.STARTUP_ENABLED !== 'false', // 默认启用
    },
    // 为保持向后兼容性而保留
    claudeCode: agentConfig,
  };
}
