/**
 * 面向本地 LLM 的 xangi 命令 ToolHandler
 *
 * 通过 exec 调用 CLI 脚本 (xangi-cmd.ts)。
 * 仅在连接 Discord 时添加 discord_* 工具。
 */
import { join } from 'path';
import type { ToolHandler, ToolResult } from './types.js';

const CMD_TIMEOUT_MS = 30_000;

/**
 * 执行 xangi-cmd.js 并返回 ToolResult
 */
async function runXangiCmd(args: string[], env?: Record<string, string>): Promise<ToolResult> {
  const cp = await import('child_process');
  const { promisify } = await import('util');
  const execFile = promisify(cp.execFile);

  // 解析 dist/cli/xangi-cmd.js 的路径
  const cmdPath = join(
    import.meta.url.replace('file://', '').replace(/\/local-llm\/xangi-tools\.js$/, ''),
    'cli',
    'xangi-cmd.js'
  );

  try {
    const { stdout, stderr } = await execFile('node', [cmdPath, ...args], {
      timeout: CMD_TIMEOUT_MS,
      env: { ...process.env, ...env },
    });
    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    return { success: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      success: false,
      output: [e.stdout, e.stderr].filter(Boolean).join('\n').trim(),
      error: e.message ?? String(err),
    };
  }
}

/**
 * 将标志转换为 CLI 参数
 */
function flagsToArgs(flags: Record<string, string>): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(flags)) {
    if (value !== undefined && value !== '') {
      args.push(`--${key}`, value);
    }
  }
  return args;
}

// ─── Discord 工具 ──────────────────────────────────────────────────

const discordHistoryHandler: ToolHandler = {
  name: 'discord_history',
  description:
    '获取频道的聊天记录。省略 channel 时使用当前频道。结果不会发送到 Discord，只返回到上下文中。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: '频道 ID（省略时使用当前频道）' },
      count: { type: 'string', description: '获取数量（默认 10，最大 100）' },
      offset: { type: 'string', description: '偏移量（回溯更早的消息）' },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const flags: Record<string, string> = {};
    if (args.channel) flags.channel = String(args.channel);
    if (args.count) flags.count = String(args.count);
    if (args.offset) flags.offset = String(args.offset);
    const env = context.channelId ? { XANGI_CHANNEL_ID: context.channelId } : undefined;
    return runXangiCmd(['discord_history', ...flagsToArgs(flags)], env);
  },
};

const discordSendHandler: ToolHandler = {
  name: 'discord_send',
  description: '向指定频道发送消息。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: '频道 ID' },
      message: { type: 'string', description: '要发送的消息' },
    },
    required: ['channel', 'message'],
  },
  async execute(args): Promise<ToolResult> {
    return runXangiCmd([
      'discord_send',
      '--channel',
      String(args.channel),
      '--message',
      String(args.message),
    ]);
  },
};

const discordChannelsHandler: ToolHandler = {
  name: 'discord_channels',
  description: '获取服务器的频道列表。',
  parameters: {
    type: 'object',
    properties: {
      guild: { type: 'string', description: '服务器（公会）ID' },
    },
    required: ['guild'],
  },
  async execute(args): Promise<ToolResult> {
    return runXangiCmd(['discord_channels', '--guild', String(args.guild)]);
  },
};

const discordSearchHandler: ToolHandler = {
  name: 'discord_search',
  description: '在频道内搜索消息（从最新 100 条中搜索）。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: '频道 ID' },
      keyword: { type: 'string', description: '搜索关键词' },
    },
    required: ['channel', 'keyword'],
  },
  async execute(args): Promise<ToolResult> {
    return runXangiCmd([
      'discord_search',
      '--channel',
      String(args.channel),
      '--keyword',
      String(args.keyword),
    ]);
  },
};

const discordEditHandler: ToolHandler = {
  name: 'discord_edit',
  description: '编辑自己的消息。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: '频道 ID' },
      'message-id': { type: 'string', description: '消息 ID' },
      content: { type: 'string', description: '新的消息内容' },
    },
    required: ['channel', 'message-id', 'content'],
  },
  async execute(args): Promise<ToolResult> {
    return runXangiCmd([
      'discord_edit',
      '--channel',
      String(args.channel),
      '--message-id',
      String(args['message-id']),
      '--content',
      String(args.content),
    ]);
  },
};

const discordDeleteHandler: ToolHandler = {
  name: 'discord_delete',
  description: '删除自己的消息。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: '频道 ID' },
      'message-id': { type: 'string', description: '消息 ID' },
    },
    required: ['channel', 'message-id'],
  },
  async execute(args): Promise<ToolResult> {
    return runXangiCmd([
      'discord_delete',
      '--channel',
      String(args.channel),
      '--message-id',
      String(args['message-id']),
    ]);
  },
};

// ─── 日程工具 ─────────────────────────────────────────────────

const scheduleListHandler: ToolHandler = {
  name: 'schedule_list',
  description: '显示日程列表。',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute(): Promise<ToolResult> {
    return runXangiCmd(['schedule_list']);
  },
};

const scheduleAddHandler: ToolHandler = {
  name: 'schedule_add',
  description:
    '添加日程。示例: "30分钟后 会议", "15:00 代码审查", "每天 9:00 早上好", "cron 0 9 * * * 早上好"',
  parameters: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: '日程设置（例如："每天 9:00 早上好"）',
      },
      channel: { type: 'string', description: '目标频道 ID' },
      platform: {
        type: 'string',
        description: '平台（discord/slack）',
        enum: ['discord', 'slack'],
      },
    },
    required: ['input', 'channel'],
  },
  async execute(args): Promise<ToolResult> {
    const flags: Record<string, string> = {
      input: String(args.input),
      channel: String(args.channel),
    };
    if (args.platform) flags.platform = String(args.platform);
    return runXangiCmd(['schedule_add', ...flagsToArgs(flags)]);
  },
};

const scheduleRemoveHandler: ToolHandler = {
  name: 'schedule_remove',
  description: '删除日程。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '日程 ID' },
    },
    required: ['id'],
  },
  async execute(args): Promise<ToolResult> {
    return runXangiCmd(['schedule_remove', '--id', String(args.id)]);
  },
};

const scheduleToggleHandler: ToolHandler = {
  name: 'schedule_toggle',
  description: '切换日程的启用/禁用状态。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '日程 ID' },
    },
    required: ['id'],
  },
  async execute(args): Promise<ToolResult> {
    return runXangiCmd(['schedule_toggle', '--id', String(args.id)]);
  },
};

// ─── 媒体工具 ─────────────────────────────────────────────────────

const mediaSendHandler: ToolHandler = {
  name: 'media_send',
  description: '向 Discord 频道发送文件。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: '频道 ID' },
      file: { type: 'string', description: '文件路径' },
    },
    required: ['channel', 'file'],
  },
  async execute(args): Promise<ToolResult> {
    return runXangiCmd([
      'media_send',
      '--channel',
      String(args.channel),
      '--file',
      String(args.file),
    ]);
  },
};

// ─── 系统工具 ───────────────────────────────────────────────────

const systemRestartHandler: ToolHandler = {
  name: 'system_restart',
  description: '重启 xangi（仅在 autoRestart 启用时有效）。',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute(): Promise<ToolResult> {
    return runXangiCmd(['system_restart']);
  },
};

const systemSettingsHandler: ToolHandler = {
  name: 'system_settings',
  description: '修改或显示 xangi 的设置。',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: '设置键名（省略则显示列表）' },
      value: { type: 'string', description: '设置值' },
    },
  },
  async execute(args): Promise<ToolResult> {
    const cliArgs = ['system_settings'];
    if (args.key) {
      cliArgs.push('--key', String(args.key));
      if (args.value !== undefined) cliArgs.push('--value', String(args.value));
    }
    return runXangiCmd(cliArgs);
  },
};

// ─── 导出 ─────────────────────────────────────────────────────────

/** 连接 Discord 时添加的工具 */
export function getDiscordTools(): ToolHandler[] {
  return [
    discordHistoryHandler,
    discordSendHandler,
    discordChannelsHandler,
    discordSearchHandler,
    discordEditHandler,
    discordDeleteHandler,
    mediaSendHandler,
  ];
}

/** 日程相关工具 */
export function getScheduleTools(): ToolHandler[] {
  return [scheduleListHandler, scheduleAddHandler, scheduleRemoveHandler, scheduleToggleHandler];
}

/** 系统相关工具 */
export function getSystemTools(): ToolHandler[] {
  return [systemRestartHandler, systemSettingsHandler];
}

/** 所有 xangi 工具（不限平台） */
export function getAllXangiTools(): ToolHandler[] {
  return [...getDiscordTools(), ...getScheduleTools(), ...getSystemTools()];
}
