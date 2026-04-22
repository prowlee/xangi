import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Message,
  AutocompleteInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { loadConfig } from './config.js';
import { isGitHubAppEnabled } from './github-auth.js';
import { resolveApproval, requestApproval, setApprovalEnabled } from './approval.js';
import { getBackendDisplayName, type AgentRunner } from './agent-runner.js';
import { BackendResolver } from './backend-resolver.js';
import { DynamicRunnerManager } from './dynamic-runner.js';
import { ClaudeCodeRunner } from './claude-code.js';
import { processManager } from './process-manager.js';
import { loadSkills, formatSkillList, type Skill } from './skills.js';
import { startSlackBot } from './slack.js';
import {
  downloadFile,
  extractFilePaths,
  stripFilePaths,
  buildPromptWithAttachments,
} from './file-utils.js';
import { initSettings, loadSettings, saveSettings, formatSettings } from './settings.js';
import { DISCORD_MAX_LENGTH, DISCORD_SAFE_LENGTH, STREAM_UPDATE_INTERVAL_MS } from './constants.js';
import {
  Scheduler,
  parseScheduleInput,
  formatScheduleList,
  SCHEDULE_SEPARATOR,
  type Platform,
  type ScheduleType,
} from './scheduler.js';
import {
  initSessions,
  getSession,
  setSession,
  deleteSession,
  ensureSession,
  incrementMessageCount,
  getActiveSessionId,
} from './sessions.js';
import { join } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { startWebChat } from './web-chat.js';
dotenvConfig({ override: true });

/** 将消息按指定字符数分割（支持自定义分隔符，默认为换行） */
function splitMessage(text: string, maxLength: number, separator: string = '\n'): string[] {
  const chunks: string[] = [];
  const blocks = text.split(separator);
  let current = '';
  for (const block of blocks) {
    const sep = current ? separator : '';
    if (current.length + sep.length + block.length > maxLength) {
      if (current) chunks.push(current.trim());
      // 如果单个块超过 maxLength，则按行回退处理
      if (block.length > maxLength) {
        const lines = block.split('\n');
        current = '';
        for (const line of lines) {
          if (current.length + line.length + 1 > maxLength) {
            if (current) chunks.push(current.trim());
            current = line;
          } else {
            current += (current ? '\n' : '') + line;
          }
        }
      } else {
        current = block;
      }
    } else {
      current += sep + block;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

/** 将调度列表按 Discord 限制分割 */
function splitScheduleContent(content: string, maxLength: number): string[] {
  const sep = '\n' + SCHEDULE_SEPARATOR + '\n';
  const chunks = splitMessage(content, maxLength, sep);
  return chunks.map((c) => c.replaceAll(SCHEDULE_SEPARATOR, ''));
}

/** 根据调度类型生成标签 */
function getTypeLabel(
  type: ScheduleType,
  options: { expression?: string; runAt?: string; channelInfo?: string }
): string {
  const channelInfo = options.channelInfo || '';
  switch (type) {
    case 'cron':
      return `🔄 重复: \`${options.expression}\`${channelInfo}`;
    case 'startup':
      return `🚀 启动时执行${channelInfo}`;
    case 'once':
    default:
      return `⏰ 执行时间: ${new Date(options.runAt!).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}${channelInfo}`;
  }
}

// 每个频道最后发送的机器人消息ID
const lastSentMessageIds = new Map<string, string>();

/** 处理中显示的停止按钮 */
function createStopButton(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('xangi_stop').setLabel('Stop').setStyle(ButtonStyle.Secondary)
  );
}

/** 完成后显示的新会话按钮 */
function createCompletedButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('xangi_new').setLabel('New').setStyle(ButtonStyle.Secondary)
  );
}

/**
 * 生成工具输入摘要（用于 Discord 显示）
 */
function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read':
      return input.file_path ? `: ${String(input.file_path).split('/').slice(-2).join('/')}` : '';
    case 'Edit':
    case 'Write':
      return input.file_path ? `: ${String(input.file_path).split('/').slice(-2).join('/')}` : '';
    case 'Bash': {
      if (!input.command) return '';
      const cmd = String(input.command);
      const cmdDisplay = `: \`${cmd.slice(0, 60)}${cmd.length > 60 ? '...' : ''}\``;
      const ghBadge = cmd.startsWith('gh ') && isGitHubAppEnabled() ? ' 🔑App' : '';
      return cmdDisplay + ghBadge;
    }
    case 'Glob':
      return input.pattern ? `: ${String(input.pattern)}` : '';
    case 'Grep':
      return input.pattern ? `: ${String(input.pattern)}` : '';
    case 'WebFetch':
      return input.url ? `: ${String(input.url).slice(0, 60)}` : '';
    case 'Agent':
      return input.description ? `: ${String(input.description)}` : '';
    case 'Skill':
      return input.skill ? `: ${String(input.skill)}` : '';
    default:
      // MCP工具 (mcp__server__tool 格式)
      if (toolName.startsWith('mcp__')) {
        const parts = toolName.split('__');
        const server = parts[1] || '';
        const tool = parts[2] || '';
        return ` (${server}/${tool})`;
      }
      return '';
  }
}

/**
 * 创建 Discord 用的工具批准回调
 */
async function main() {
  const config = loadConfig();

  // 检查允许列表（"*" 表示允许所有人，支持逗号分隔的多用户）
  const discordAllowed = config.discord.allowedUsers || [];
  const slackAllowed = config.slack.allowedUsers || [];

  if (config.discord.enabled && discordAllowed.length === 0) {
    console.error('[xangi] Error: DISCORD_ALLOWED_USER must be set (use "*" to allow everyone)');
    process.exit(1);
  }
  if (config.slack.enabled && slackAllowed.length === 0) {
    console.error('[xangi] Error: SLACK_ALLOWED_USER must be set (use "*" to allow everyone)');
    process.exit(1);
  }

  if (discordAllowed.includes('*')) {
    console.log('[xangi] Discord: All users are allowed');
  } else {
    console.log(`[xangi] Discord: Allowed users: ${discordAllowed.join(', ')}`);
  }
  if (slackAllowed.includes('*')) {
    console.log('[xangi] Slack: All users are allowed');
  } else if (slackAllowed.length > 0) {
    console.log(`[xangi] Slack: Allowed users: ${slackAllowed.join(', ')}`);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  // 创建后端解析器和动态运行器管理器
  const resolver = new BackendResolver(config);
  const agentRunner = new DynamicRunnerManager(config, resolver);
  const backendName = getBackendDisplayName(config.agent.backend);
  console.log(
    `[xangi] Using ${backendName} as agent backend (platform: ${config.agent.platform ?? 'all'})`
  );

  // 加载技能
  const workdir = config.agent.config.workdir || process.cwd();
  let skills: Skill[] = loadSkills(workdir);
  console.log(`[xangi] Loaded ${skills.length} skills from ${workdir}`);

  // 初始化设置
  initSettings(workdir);
  const initialSettings = loadSettings();
  console.log(`[xangi] Settings loaded: autoRestart=${initialSettings.autoRestart}`);

  // 初始化调度器（使用工作区的 .xangi）
  const dataDir = process.env.DATA_DIR || join(workdir, '.xangi');
  const scheduler = new Scheduler(dataDir);

  // 初始化会话持久化
  initSessions(dataDir);

  // 启动 Web 聊天 UI
  if (process.env.WEB_CHAT_ENABLED === 'true') {
    startWebChat({ agentRunner });
  }

  // 初始化 GitHub 认证
  const { initGitHubAuth } = await import('./github-auth.js');
  initGitHubAuth();

  // 工具批准开关（默认禁用）
  if (process.env.APPROVAL_ENABLED === 'true') {
    setApprovalEnabled(true);
  }

  // 斜杠命令定义
  const commands: ReturnType<SlashCommandBuilder['toJSON']>[] = [
    new SlashCommandBuilder().setName('new').setDescription('开始新会话').toJSON(),
    new SlashCommandBuilder().setName('stop').setDescription('停止正在执行的任务').toJSON(),
    new SlashCommandBuilder()
      .setName('skills')
      .setDescription('显示可用技能列表')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('skill')
      .setDescription('执行技能')
      .addStringOption((option) =>
        option.setName('name').setDescription('技能名称').setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) => option.setName('args').setDescription('参数').setRequired(false))
      .toJSON(),
    new SlashCommandBuilder().setName('settings').setDescription('显示当前设置').toJSON(),
    new SlashCommandBuilder().setName('restart').setDescription('重启机器人').toJSON(),
    new SlashCommandBuilder()
      .setName('skip')
      .setDescription('跳过权限确认并执行消息')
      .addStringOption((option) =>
        option.setName('message').setDescription('要执行的消息').setRequired(true)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('schedule')
      .setDescription('调度管理')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('添加调度')
          .addStringOption((opt) =>
            opt
              .setName('input')
              .setDescription('示例: "30分钟后 会议" / "每天 9:00 早上好"')
              .setRequired(true)
          )
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('显示调度列表'))
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('删除调度')
          .addStringOption((opt) =>
            opt.setName('id').setDescription('调度ID').setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('toggle')
          .setDescription('切换调度的启用/禁用')
          .addStringOption((opt) =>
            opt.setName('id').setDescription('调度ID').setRequired(true)
          )
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('backend')
      .setDescription('切换后端/模型')
      .addSubcommand((sub) => sub.setName('show').setDescription('显示当前后端设置'))
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('设置后端/模型')
          .addStringOption((opt) =>
            opt
              .setName('type')
              .setDescription('后端名称')
              .setRequired(true)
              .addChoices(
                { name: 'Claude Code', value: 'claude-code' },
                { name: 'Codex', value: 'codex' },
                { name: 'Gemini', value: 'gemini' },
                { name: 'Local LLM', value: 'local-llm' }
              )
          )
          .addStringOption((opt) => opt.setName('model').setDescription('模型名称'))
          .addStringOption((opt) =>
            opt
              .setName('effort')
              .setDescription('effort级别（用于Claude Code）')
              .addChoices(
                { name: '默认', value: 'none' },
                { name: 'low', value: 'low' },
                { name: 'medium', value: 'medium' },
                { name: 'high', value: 'high' },
                { name: 'max', value: 'max' }
              )
          )
      )
      .addSubcommand((sub) => sub.setName('reset').setDescription('恢复默认'))
      .addSubcommand((sub) =>
        sub.setName('list').setDescription('显示可用后端列表')
      )
      .toJSON(),
  ];

  // 将每个技能作为单独的斜杠命令添加
  for (const skill of skills) {
    // Discord命令名称仅限小写字母数字和连字符（最大32字符）
    const cmdName = skill.name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32);

    if (cmdName) {
      commands.push(
        new SlashCommandBuilder()
          .setName(cmdName)
          .setDescription(skill.description.slice(0, 100) || `执行${skill.name}技能`)
          .addStringOption((option) =>
            option.setName('args').setDescription('参数（可选）').setRequired(false)
          )
          .toJSON()
      );
    }
  }

  // 注册斜杠命令
  client.once(Events.ClientReady, async (c) => {
    console.log(`[xangi] Ready! Logged in as ${c.user.tag}`);

    // 启动工具批准服务器（用于 Claude Code PreToolUse 钩子）
    const { startApprovalServer } = await import('./approval-server.js');
    startApprovalServer(async (toolName, toolInput, dangerDescription) => {
      // 向第一个自动回复频道发送批准消息
      const approvalChannelId = config.discord.autoReplyChannels?.[0];
      if (!approvalChannelId) return true; // 未设置频道则允许
      const channel = c.channels.cache.get(approvalChannelId);
      if (!channel || !('send' in channel)) return true;

      const command =
        toolName === 'Bash'
          ? String((toolInput as Record<string, unknown>).command || '').slice(0, 200)
          : `${toolName}: ${String((toolInput as Record<string, unknown>).file_path || '')}`;

      return requestApproval(
        approvalChannelId,
        { command, matches: dangerDescription },
        (approvalId, danger) => {
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`xangi_approve_${approvalId}`)
              .setLabel('允许')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`xangi_deny_${approvalId}`)
              .setLabel('拒绝')
              .setStyle(ButtonStyle.Danger)
          );
          (channel as unknown as { send: (opts: unknown) => Promise<unknown> }).send({
            content: `⚠️ **检测到危险命令**\n\`\`\`\n${danger.command}\n\`\`\`\n${danger.matches.join(', ')}\n\n2分钟内无响应则自动拒绝`,
            components: [row],
          });
        }
      );
    });

    // 启动工具服务器（供 Claude Code 通过 curl 调用的 API）
    const { startToolServer } = await import('./tool-server.js');
    startToolServer();

    const rest = new REST({ version: '10' }).setToken(config.discord.token);
    try {
      // 注册为公会命令（即时生效）
      const guilds = c.guilds.cache;
      console.log(`[xangi] Found ${guilds.size} guilds`);

      for (const [guildId, guild] of guilds) {
        await rest.put(Routes.applicationGuildCommands(c.user.id, guildId), {
          body: commands,
        });
        console.log(`[xangi] ${commands.length} slash commands registered for: ${guild.name}`);
      }

      // 清除全局命令（防止重复）
      await rest.put(Routes.applicationCommands(c.user.id), { body: [] });
      console.log('[xangi] Cleared global commands');
    } catch (error) {
      console.error('[xangi] Failed to register slash commands:', error);
    }
  });

  // 斜杠命令处理
  client.on(Events.InteractionCreate, async (interaction) => {
    // 自动补全处理
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction, skills);
      return;
    }

    // 按钮交互处理
    if (interaction.isButton()) {
      const channelId = interaction.channelId;
      // 权限检查
      if (
        !config.discord.allowedUsers?.includes('*') &&
        !config.discord.allowedUsers?.includes(interaction.user.id)
      ) {
        await interaction.reply({ content: '未授权的用户', ephemeral: true });
        return;
      }

      if (interaction.customId === 'xangi_stop') {
        const stopped = processManager.stop(channelId) || agentRunner.cancel?.(channelId) || false;
        await interaction.deferUpdate().catch(() => {});
        if (!stopped) {
          await interaction.followUp({
            content: '没有正在执行的任务',
            ephemeral: true,
          });
        }
        return;
      }

      if (interaction.customId === 'xangi_new') {
        deleteSession(channelId);
        agentRunner.destroy?.(channelId);
        // 删除按钮并更新消息
        await interaction
          .update({
            components: [],
          })
          .catch(() => {});
        await interaction
          .followUp({ content: '🆕 已开始新会话', ephemeral: true })
          .catch(() => {});
        return;
      }

      // 批准按钮
      if (interaction.customId.startsWith('xangi_approve_')) {
        const approvalId = interaction.customId.replace('xangi_approve_', '');
        resolveApproval(approvalId, true);
        await interaction.update({ content: '✅ 已允许', components: [] }).catch(() => {});
        return;
      }
      if (interaction.customId.startsWith('xangi_deny_')) {
        const approvalId = interaction.customId.replace('xangi_deny_', '');
        resolveApproval(approvalId, false);
        await interaction.update({ content: '❌ 已拒绝', components: [] }).catch(() => {});
        return;
      }

      // 未知按钮 → 只回复 ACK
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    // 权限列表检查（"*" 表示允许所有人）
    if (
      !config.discord.allowedUsers?.includes('*') &&
      !config.discord.allowedUsers?.includes(interaction.user.id)
    ) {
      await interaction.reply({ content: '未授权的用户', ephemeral: true });
      return;
    }

    const channelId = interaction.channelId;

    if (interaction.commandName === 'new') {
      deleteSession(channelId);
      agentRunner.destroy?.(channelId);
      await interaction.reply('🆕 已开始新会话');
      return;
    }

    if (interaction.commandName === 'stop') {
      const stopped = processManager.stop(channelId) || agentRunner.cancel?.(channelId) || false;
      if (stopped) {
        await interaction.reply('🛑 已停止任务');
      } else {
        await interaction.reply({ content: '没有正在执行的任务', ephemeral: true });
      }
      return;
    }

    if (interaction.commandName === 'settings') {
      const settings = loadSettings();
      await interaction.reply(formatSettings(settings));
      return;
    }

    if (interaction.commandName === 'backend') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'show') {
        const resolved = agentRunner.resolveForChannel(channelId);
        const override = resolver.getChannelOverride(channelId);
        const defaultRes = resolver.getDefault();
        const lines = [
          `**当前后端设置** (<#${channelId}>)`,
          `- 后端: **${getBackendDisplayName(resolved.backend)}**`,
        ];
        if (resolved.model) lines.push(`- 模型: ${resolved.model}`);
        if (resolved.effort) lines.push(`- effort: ${resolved.effort}`);
        if (override) {
          lines.push(`- 来源: 频道设置`);
        } else {
          lines.push(`- 来源: 默认 (.env)`);
        }
        lines.push(
          ``,
          `**默认:** ${getBackendDisplayName(defaultRes.backend)}${defaultRes.model ? ` (${defaultRes.model})` : ''}`
        );
        await interaction.reply(lines.join('\n'));
        return;
      }

      if (sub === 'set') {
        const backendValue = interaction.options.getString(
          'type',
          true
        ) as import('./config.js').AgentBackend;
        const modelValue = interaction.options.getString('model') ?? undefined;
        const rawEffort = interaction.options.getString('effort');
        const effortValue =
          rawEffort && rawEffort !== 'none'
            ? (rawEffort as import('./config.js').EffortLevel)
            : undefined;

        // 权限检查：如果 ALLOWED_BACKENDS 未设置则不可切换
        if (!resolver.isBackendAllowed(backendValue)) {
          const allowedBackends = resolver.getAllowedBackends();
          if (!config.agent.allowedBackends) {
            await interaction.reply({
              content: `❌ 后端切换未启用。\n请在 .env 中设置 \`ALLOWED_BACKENDS\`。`,
              ephemeral: true,
            });
          } else {
            await interaction.reply({
              content: `❌ 后端 \`${backendValue}\` 未允许\n允许: ${allowedBackends.map((b) => getBackendDisplayName(b)).join(', ')}`,
              ephemeral: true,
            });
          }
          return;
        }
        if (modelValue && !resolver.isModelAllowed(modelValue)) {
          await interaction.reply({
            content: `❌ 模型 \`${modelValue}\` 未允许`,
            ephemeral: true,
          });
          return;
        }

        // Local LLM 的情况，检查 Ollama 中是否存在该模型
        if (backendValue === 'local-llm' && modelValue) {
          try {
            const ollamaBase = process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434';
            const res = await fetch(`${ollamaBase}/api/tags`, {
              signal: AbortSignal.timeout(3000),
            });
            if (res.ok) {
              const data = (await res.json()) as {
                models?: Array<{ name: string }>;
              };
              const modelNames = data.models?.map((m) => m.name) ?? [];
              // 完全匹配 "qwen3.5:9b"，或前缀匹配如 "qwen3.5"
              const found = modelNames.some(
                (n) => n === modelValue || n.startsWith(modelValue + ':')
              );
              if (!found) {
                await interaction.reply({
                  content: `❌ 模型 \`${modelValue}\` 未安装到 Ollama\n已安装: ${modelNames.map((n) => `\`${n}\``).join(', ')}`,
                  ephemeral: true,
                });
                return;
              }
            }
          } catch {
            // Ollama 连接失败则跳过模型检查
          }
        }

        // 保存到 channelOverrides
        resolver.setChannelOverride(channelId, {
          backend: backendValue,
          model: modelValue,
          effort: effortValue,
        });

        // 销毁会话和运行器
        agentRunner.switchBackend(channelId);

        // 明确显示切换结果
        const display = getBackendDisplayName(backendValue);
        const resolvedModel =
          modelValue ||
          (backendValue === 'local-llm'
            ? process.env.LOCAL_LLM_MODEL || '(默认)'
            : backendValue === 'claude-code'
              ? process.env.AGENT_MODEL || 'Claude (默认)'
              : '(默认)');
        const lines = [
          `🔄 已切换模型。将开始新会话。`,
          `- 后端: **${display}**`,
          `- 模型: **${resolvedModel}**`,
        ];
        if (effortValue) lines.push(`- effort: **${effortValue}**`);
        await interaction.reply(lines.join('\n'));
        return;
      }

      if (sub === 'reset') {
        resolver.deleteChannelOverride(channelId);
        agentRunner.switchBackend(channelId);
        const defaultRes = resolver.getDefault();
        await interaction.reply(
          `🔄 已恢复默认 (**${getBackendDisplayName(defaultRes.backend)}**)。将开始新会话。`
        );
        return;
      }

      if (sub === 'list') {
        await interaction.deferReply();
        const allowed = resolver.getAllowedBackends();
        const allowedModels = resolver.getAllowedModels();
        const defaultRes = resolver.getDefault();
        const lines = ['**可用后端:**'];
        for (const b of allowed) {
          const isDefault = b === defaultRes.backend;
          lines.push(`- ${getBackendDisplayName(b)}${isDefault ? ' (默认)' : ''}`);
        }
        if (allowedModels && allowedModels.length > 0) {
          lines.push('', '**允许的模型:**');
          for (const m of allowedModels) {
            lines.push(`- \`${m}\``);
          }
        }

        // 如果允许 Local LLM，获取 Ollama 模型列表
        if (allowed.includes('local-llm')) {
          try {
            const ollamaBase = process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434';
            const res = await fetch(`${ollamaBase}/api/tags`, {
              signal: AbortSignal.timeout(3000),
            });
            if (res.ok) {
              const data = (await res.json()) as {
                models?: Array<{ name: string; size: number }>;
              };
              if (data.models && data.models.length > 0) {
                lines.push('', '**Ollama 模型（已安装）:**');
                for (const m of data.models) {
                  const sizeGB = (m.size / 1e9).toFixed(1);
                  lines.push(`- \`${m.name}\` (${sizeGB}GB)`);
                }
              }
            }
          } catch {
            // Ollama 连接失败则忽略
          }
        }

        if (!config.agent.allowedBackends) {
          lines.push('', '⚠️ 未设置 `ALLOWED_BACKENDS`，切换功能已禁用。');
        }

        await interaction.editReply(lines.join('\n'));
        return;
      }
    }

    if (interaction.commandName === 'skip') {
      const skipMessage = interaction.options.getString('message', true);
      await interaction.deferReply();

      try {
        const sessionId = getSession(channelId);
        const appSessionId = ensureSession(channelId, { platform: 'discord' });

        // 使用一次性 ClaudeCodeRunner（确保 skipPermissions 生效）
        const skipRunner = new ClaudeCodeRunner(config.agent.config);
        const runResult = await skipRunner.run(skipMessage, {
          skipPermissions: true,
          sessionId,
          channelId,
          appSessionId,
        });

        setSession(channelId, runResult.sessionId);

        // 提取文件路径并发送附件
        const filePaths = extractFilePaths(runResult.result);
        const displayText =
          filePaths.length > 0 ? stripFilePaths(runResult.result) : runResult.result;
        const cleanText = stripCommandsFromDisplay(displayText);

        const chunks = splitMessage(cleanText, DISCORD_SAFE_LENGTH);
        await interaction.editReply(chunks[0] || '✅');
        if (chunks.length > 1 && 'send' in interaction.channel!) {
          const channel = interaction.channel as unknown as {
            send: (content: string) => Promise<unknown>;
          };
          for (let i = 1; i < chunks.length; i++) {
            await channel.send(chunks[i]);
          }
        }

        // 发送文件附件
        if (filePaths.length > 0 && interaction.channel && 'send' in interaction.channel) {
          try {
            await (
              interaction.channel as unknown as {
                send: (options: { files: { attachment: string }[] }) => Promise<unknown>;
              }
            ).send({
              files: filePaths.map((fp) => ({ attachment: fp })),
            });
            console.log(`[xangi] Sent ${filePaths.length} file(s) via /skip`);
          } catch (err) {
            console.error('[xangi] Failed to send files via /skip:', err);
          }
        }

        // SYSTEM_COMMAND 处理
        handleSettingsFromResponse(runResult.result);

        // !discord 命令处理
        if (interaction.channel) {
          const fakeMessage = { channel: interaction.channel } as Message;
          await handleDiscordCommandsInResponse(runResult.result, fakeMessage);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        let errorDetail: string;
        if (errorMsg.includes('timed out')) {
          errorDetail = `⏱️ 超时了`;
        } else if (errorMsg.includes('Process exited unexpectedly')) {
          errorDetail = `💥 AI进程意外终止`;
        } else if (errorMsg.includes('Circuit breaker')) {
          errorDetail = '🔌 AI进程暂时暂停中';
        } else {
          errorDetail = `❌ 错误: ${errorMsg.slice(0, 200)}`;
        }
        await interaction.editReply(errorDetail).catch(() => {});
      }
      return;
    }

    if (interaction.commandName === 'restart') {
      const settings = loadSettings();
      if (!settings.autoRestart) {
        await interaction.reply('⚠️ 自动重启已禁用。请先启用。');
        return;
      }
      await interaction.reply('🔄 即将重启...');
      setTimeout(() => process.exit(0), 1000);
      return;
    }

    if (interaction.commandName === 'schedule') {
      await handleScheduleCommand(interaction, scheduler, config.scheduler);
      return;
    }

    if (interaction.commandName === 'skills') {
      // 重新加载技能
      skills = loadSkills(workdir);
      await interaction.reply(formatSkillList(skills));
      return;
    }

    if (interaction.commandName === 'skill') {
      await handleSkill(interaction, agentRunner, config, channelId);
      return;
    }

    // 处理单个技能命令
    const matchedSkill = skills.find((s) => {
      const cmdName = s.name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 32);
      return cmdName === interaction.commandName;
    });

    if (matchedSkill) {
      await handleSkillCommand(interaction, agentRunner, config, channelId, matchedSkill.name);
      return;
    }
  });

  // 从 Discord 链接获取消息内容的函数
  async function fetchDiscordLinkContent(text: string): Promise<string> {
    const linkRegex = /https?:\/\/(?:www\.)?discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/g;
    const matches = [...text.matchAll(linkRegex)];

    if (matches.length === 0) return text;

    let result = text;
    for (const match of matches) {
      const [fullUrl, , channelId, messageId] = match;
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && 'messages' in channel) {
          const fetchedMessage = await channel.messages.fetch(messageId);
          const author = fetchedMessage.author.tag;
          const content = fetchedMessage.content || '(仅附件)';
          const attachmentInfo =
            fetchedMessage.attachments.size > 0
              ? `\n[附件: ${fetchedMessage.attachments.map((a) => a.name).join(', ')}]`
              : '';

          const quotedContent = `\n---\n📎 引用消息 (${author}):\n${content}${attachmentInfo}\n---\n`;
          result = result.replace(fullUrl, quotedContent);
          console.log(`[xangi] Fetched linked message from channel ${channelId}`);
        }
      } catch (err) {
        console.error(`[xangi] Failed to fetch linked message: ${fullUrl}`, err);
        // 获取失败时保留原链接
      }
    }

    return result;
  }

  // 获取回复源消息并添加到提示词中的函数
  async function fetchReplyContent(message: Message): Promise<string | null> {
    if (!message.reference?.messageId) return null;

    try {
      const channel = message.channel;
      if (!('messages' in channel)) return null;

      const repliedMessage = await channel.messages.fetch(message.reference.messageId);
      const author = repliedMessage.author.tag;
      const content = repliedMessage.content || '(仅附件)';
      const attachmentInfo =
        repliedMessage.attachments.size > 0
          ? `\n[附件: ${repliedMessage.attachments.map((a) => a.name).join(', ')}]`
          : '';

      console.log(`[xangi] Fetched reply-to message from ${author}`);
      return `\n---\n💬 回复源 (${author}):\n${content}${attachmentInfo}\n---\n`;
    } catch (err) {
      console.error(`[xangi] Failed to fetch reply-to message:`, err);
      return null;
    }
  }

  /**
   * 无害化消息内容中的频道提及 <#ID>
   * 防止 fetchChannelMessages() 导致的意外二次展开
   */
  function sanitizeChannelMentions(content: string): string {
    return content.replace(/<#(\d+)>/g, '#$1');
  }

  // 从频道提及获取最新消息的函数
  async function fetchChannelMessages(text: string): Promise<string> {
    const channelMentionRegex = /<#(\d+)>/g;
    const matches = [...text.matchAll(channelMentionRegex)];

    if (matches.length === 0) return text;

    let result = text;
    for (const match of matches) {
      const [fullMention, channelId] = match;
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && 'messages' in channel) {
          const messages = await channel.messages.fetch({ limit: 10 });
          const channelName = 'name' in channel ? channel.name : 'unknown';

          const messageList = messages
            .reverse()
            .map((m) => {
              const time = m.createdAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
              const content = sanitizeChannelMentions(m.content || '(仅附件)');
              return `[${time}] ${m.author.tag}: ${content}`;
            })
            .join('\n');

          const expandedContent = `\n---\n📺 #${channelName} 的最新消息:\n${messageList}\n---\n`;
          result = result.replace(fullMention, expandedContent);
          console.log(`[xangi] Fetched messages from channel #${channelName}`);
        }
      } catch (err) {
        console.error(`[xangi] Failed to fetch channel messages: ${channelId}`, err);
      }
    }

    return result;
  }

  /**
   * 为频道提及 <#ID> 添加频道ID注释
   * 示例: <#123456> → <#123456> [频道ID: 123456]
   */
  function annotateChannelMentions(text: string): string {
    return text.replace(/<#(\d+)>/g, (match, id) => `${match} [频道ID: ${id}]`);
  }

  /**
   * 根据 Discord 的 2000 字符限制分割消息
   */
  function chunkDiscordMessage(message: string, limit = DISCORD_MAX_LENGTH): string[] {
    if (message.length <= limit) return [message];

    const chunks: string[] = [];
    let buf = '';

    for (const line of message.split('\n')) {
      if (line.length > limit) {
        // 单行超过限制 → 刷新缓冲区并硬分割
        if (buf) {
          chunks.push(buf);
          buf = '';
        }
        for (let j = 0; j < line.length; j += limit) {
          chunks.push(line.slice(j, j + limit));
        }
        continue;
      }
      const candidate = buf ? `${buf}\n${line}` : line;
      if (candidate.length > limit) {
        chunks.push(buf);
        buf = line;
      } else {
        buf = candidate;
      }
    }
    if (buf) chunks.push(buf);
    return chunks;
  }

  // 处理 Discord 命令的函数
  // feedback: true 时，不将 response 发送到 Discord，而是重新注入到代理
  async function handleDiscordCommand(
    text: string,
    sourceMessage?: Message,
    fallbackChannelId?: string
  ): Promise<{ handled: boolean; response?: string; feedback?: boolean }> {
    // !discord send <#channelId> message (支持多行)
    const sendMatch = text.match(/^!discord\s+send\s+<#(\d+)>\s+(.+)$/s);
    if (sendMatch) {
      const [, channelId, content] = sendMatch;
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && 'send' in channel) {
          const typedChannel = channel as {
            send: (options: {
              content: string;
              allowedMentions: { parse: never[] };
            }) => Promise<unknown>;
          };
          // 按2000字符限制分割发送
          const chunks = chunkDiscordMessage(content);
          for (const chunk of chunks) {
            await typedChannel.send({
              content: chunk,
              allowedMentions: { parse: [] },
            });
          }
          const channelName = 'name' in channel ? channel.name : 'unknown';
          console.log(`[xangi] Sent message to #${channelName} (${chunks.length} chunk(s))`);
          return { handled: true, response: `✅ 已向 #${channelName} 发送消息` };
        }
      } catch (err) {
        console.error(`[xangi] Failed to send message to channel: ${channelId}`, err);
        return { handled: true, response: `❌ 向频道发送消息失败` };
      }
    }

    // !discord channels
    if (text.match(/^!discord\s+channels$/)) {
      if (!sourceMessage) {
        return {
          handled: true,
          response: '⚠️ channels 命令不能从调度器使用',
        };
      }
      try {
        const guild = sourceMessage.guild;
        if (guild) {
          const channels = guild.channels.cache
            .filter((c) => c.type === 0) // 仅文本频道
            .map((c) => `- #${c.name} (<#${c.id}>)`)
            .join('\n');
          return { handled: true, response: `📺 频道列表:\n${channels}` };
        }
      } catch (err) {
        console.error(`[xangi] Failed to list channels`, err);
        return { handled: true, response: `❌ 获取频道列表失败` };
      }
    }

    // !discord history [数量] [offset:偏移量] [频道ID]
    const historyMatch = text.match(
      /^!discord\s+history(?:\s+(\d+))?(?:\s+offset:(\d+))?(?:\s+<#(\d+)>)?$/
    );
    if (historyMatch) {
      const count = Math.min(parseInt(historyMatch[1] || '10', 10), 100);
      const offset = parseInt(historyMatch[2] || '0', 10);
      const targetChannelId = historyMatch[3];
      try {
        let targetChannel;
        if (targetChannelId) {
          targetChannel = await client.channels.fetch(targetChannelId);
        } else if (sourceMessage) {
          targetChannel = sourceMessage.channel;
        } else if (fallbackChannelId) {
          targetChannel = await client.channels.fetch(fallbackChannelId);
        }

        if (targetChannel && 'messages' in targetChannel) {
          let beforeId: string | undefined;

          // 指定 offset 时：先获取 offset 条消息并跳过
          if (offset > 0) {
            const skipMessages = await targetChannel.messages.fetch({ limit: offset });
            if (skipMessages.size > 0) {
              beforeId = skipMessages.lastKey();
            }
          }

          const fetchOptions: { limit: number; before?: string } = { limit: count };
          if (beforeId) {
            fetchOptions.before = beforeId;
          }
          const messages = await targetChannel.messages.fetch(fetchOptions);
          const channelName = 'name' in targetChannel ? targetChannel.name : 'unknown';

          const rangeStart = offset;
          const rangeEnd = offset + messages.size;
          const messageList = messages
            .reverse()
            .map((m) => {
              const time = m.createdAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
              const content = sanitizeChannelMentions(
                (m.content || '(仅附件)').slice(0, 200)
              );
              const attachments =
                m.attachments.size > 0
                  ? '\n' + m.attachments.map((a) => `  📎 ${a.name} ${a.url}`).join('\n')
                  : '';
              return `[${time}] (ID:${m.id}) ${m.author.tag}: ${content}${attachments}`;
            })
            .join('\n');

          const offsetLabel =
            offset > 0 ? `第${rangeStart}〜${rangeEnd}条` : `最新${messages.size}条`;
          console.log(
            `[xangi] Fetched ${messages.size} history messages from #${channelName} (offset: ${offset})`
          );
          return {
            handled: true,
            feedback: true,
            response: `📺 #${channelName} 的频道历史（${offsetLabel}）:\n${messageList}`,
          };
        }

        if (!sourceMessage && !targetChannelId && !fallbackChannelId) {
          return {
            handled: true,
            feedback: true,
            response:
              '⚠️ history 命令请指定频道ID（示例: !discord history 20 <#123>）',
          };
        }
        return { handled: true, feedback: true, response: '❌ 未找到频道' };
      } catch (err) {
        console.error(`[xangi] Failed to fetch history`, err);
        return { handled: true, feedback: true, response: '❌ 获取历史失败' };
      }
    }

    // !discord search <关键词>
    const searchMatch = text.match(/^!discord\s+search\s+(.+)$/);
    if (searchMatch) {
      if (!sourceMessage) {
        return {
          handled: true,
          response: '⚠️ search 命令不能从调度器使用',
        };
      }
      const [, keyword] = searchMatch;
      try {
        // 在当前频道搜索
        const channel = sourceMessage.channel;
        if ('messages' in channel) {
          const messages = await channel.messages.fetch({ limit: 100 });
          const matched = messages.filter((m) =>
            m.content.toLowerCase().includes(keyword.toLowerCase())
          );
          if (matched.size > 0) {
            const results = matched
              .first(10)
              ?.map((m) => {
                const time = m.createdAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
                return `[${time}] ${m.author.tag}: ${sanitizeChannelMentions(m.content.slice(0, 200))}`;
              })
              .join('\n');
            return {
              handled: true,
              feedback: true,
              response: `🔍 “${keyword}” 的搜索结果 (${matched.size}条):\n${results}`,
            };
          }
        }
        return {
          handled: true,
          feedback: true,
          response: `🔍 未找到与“${keyword}”匹配的消息`,
        };
      } catch (err) {
        console.error(`[xangi] Failed to search messages`, err);
        return { handled: true, response: `❌ 搜索失败` };
      }
    }

    // !discord delete <messageId 或 link>
    const deleteMatch = text.match(/^!discord\s+delete\s+(.+)$/);
    if (deleteMatch) {
      const arg = deleteMatch[1].trim();

      try {
        let messageId: string;
        let targetChannelId: string | undefined;

        // 从消息链接中提取频道ID和消息ID
        const linkMatch = arg.match(/discord\.com\/channels\/\d+\/(\d+)\/(\d+)/);
        if (linkMatch) {
          targetChannelId = linkMatch[1];
          messageId = linkMatch[2];
        } else if (/^\d+$/.test(arg)) {
          messageId = arg;
        } else {
          return {
            handled: true,
            feedback: true,
            response: '❌ 格式无效。请指定消息ID或链接',
          };
        }

        // 如果从链接获取到了频道ID则使用该频道，否则使用当前频道
        let channel;
        if (targetChannelId) {
          channel = await client.channels.fetch(targetChannelId);
        } else if (sourceMessage) {
          channel = sourceMessage.channel;
        } else if (fallbackChannelId) {
          channel = await client.channels.fetch(fallbackChannelId);
        }

        if (channel && 'messages' in channel) {
          const msg = await channel.messages.fetch(messageId);
          // 只能删除自己的消息
          if (msg.author.id !== client.user?.id) {
            return {
              handled: true,
              feedback: true,
              response: '❌ 只能删除自己的消息',
            };
          }
          await msg.delete();
          const deletedChannelId =
            targetChannelId || sourceMessage?.channel.id || fallbackChannelId;
          console.log(`[xangi] Deleted message ${messageId} in channel ${deletedChannelId}`);
          return { handled: true, feedback: true, response: '🗑️ 已删除消息' };
        }
        return {
          handled: true,
          feedback: true,
          response: '❌ 无法在此频道删除消息',
        };
      } catch (err) {
        console.error(`[xangi] Failed to delete message:`, err);
        return { handled: true, feedback: true, response: '❌ 删除消息失败' };
      }
    }

    // !discord edit <messageId or link> <newContent>
    const editMatch = text.match(/^!discord\s+edit\s+(\S+)\s+([\s\S]+)$/);
    if (editMatch) {
      const arg = editMatch[1].trim();
      const newContent = editMatch[2].trim();

      if (!newContent) {
        return {
          handled: true,
          feedback: true,
          response: '❌ 请指定编辑后的消息内容',
        };
      }

      try {
        let messageId: string;
        let targetChannelId: string | undefined;

        if (arg === 'last') {
          // 编辑自己上一条消息
          const currentChannelId = sourceMessage?.channel.id || fallbackChannelId;
          if (!currentChannelId) {
            return {
              handled: true,
              feedback: true,
              response: '❌ 无法确定频道',
            };
          }
          const lastId = lastSentMessageIds.get(currentChannelId);
          if (!lastId) {
            return {
              handled: true,
              feedback: true,
              response:
                '❌ 未找到上一条消息（本会话中可能尚未发送任何消息）',
            };
          }
          messageId = lastId;
        } else {
          // 从消息链接中提取频道ID和消息ID
          const linkMatch = arg.match(/discord\.com\/channels\/\d+\/(\d+)\/(\d+)/);
          if (linkMatch) {
            targetChannelId = linkMatch[1];
            messageId = linkMatch[2];
          } else if (/^\d+$/.test(arg)) {
            messageId = arg;
          } else {
            return {
              handled: true,
              feedback: true,
              response: '❌ 格式无效。请指定消息ID、链接或 last',
            };
          }
        }

        // 如果从链接获取到了频道ID则使用该频道，否则使用当前频道
        let channel;
        if (targetChannelId) {
          channel = await client.channels.fetch(targetChannelId);
        } else if (sourceMessage) {
          channel = sourceMessage.channel;
        } else if (fallbackChannelId) {
          channel = await client.channels.fetch(fallbackChannelId);
        }

        if (channel && 'messages' in channel) {
          const msg = await channel.messages.fetch(messageId);
          // 只能编辑自己的消息
          if (msg.author.id !== client.user?.id) {
            return {
              handled: true,
              feedback: true,
              response: '❌ 只能编辑自己的消息',
            };
          }
          await msg.edit(newContent);
          const editedChannelId = targetChannelId || sourceMessage?.channel.id || fallbackChannelId;
          console.log(`[xangi] Edited message ${messageId} in channel ${editedChannelId}`);
          return { handled: true, feedback: true, response: '✏️ 已编辑消息' };
        }
        return {
          handled: true,
          feedback: true,
          response: '❌ 无法在此频道编辑消息',
        };
      } catch (err) {
        console.error(`[xangi] Failed to edit message:`, err);
        return { handled: true, feedback: true, response: '❌ 编辑消息失败' };
      }
    }

    return { handled: false };
  }

  /**
   * 从 AI 的响应中检测并执行 !discord 命令
   * 忽略代码块内的命令
   * !discord send 支持多行消息（一直吸收到下一个 !discord / !schedule 命令行）
   * feedback: true 的命令结果不发送到 Discord，而是收集到反馈数组中返回
   */
  async function handleDiscordCommandsInResponse(
    text: string,
    sourceMessage?: Message,
    fallbackChannelId?: string
  ): Promise<string[]> {
    const lines = text.split('\n');
    let inCodeBlock = false;
    let i = 0;
    const feedbackResults: string[] = [];

    while (i < lines.length) {
      const line = lines[i];

      // 跟踪代码块的开始/结束
      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        i++;
        continue;
      }

      // 代码块内跳过
      if (inCodeBlock) {
        i++;
        continue;
      }

      const trimmed = line.trim();

      // !discord send 的多行支持
      const sendMatch = trimmed.match(/^!discord\s+send\s+<#(\d+)>\s*(.*)/);
      if (sendMatch) {
        const firstLineContent = sendMatch[2] ?? '';

        if (firstLineContent.trim() === '') {
          // 内容为空 → 吸收到下一个 !discord / !schedule 命令行（隐式多行）
          const bodyLines: string[] = [];
          let inBodyCodeBlock = false;
          i++;
          while (i < lines.length) {
            const bodyLine = lines[i];
            if (bodyLine.trim().startsWith('```')) {
              inBodyCodeBlock = !inBodyCodeBlock;
            }
            // 代码块外遇到下一个命令行则停止吸收
            if (
              !inBodyCodeBlock &&
              (bodyLine.trim().startsWith('!discord ') || bodyLine.trim().startsWith('!schedule'))
            ) {
              break;
            }
            bodyLines.push(bodyLine);
            i++;
          }
          const fullMessage = bodyLines.join('\n').trim();
          if (fullMessage) {
            const commandText = `!discord send <#${sendMatch[1]}> ${fullMessage}`;
            console.log(
              `[xangi] Processing discord command from response: ${commandText.slice(0, 50)}...`
            );
            const result = await handleDiscordCommand(
              commandText,
              sourceMessage,
              fallbackChannelId
            );
            if (result.handled && result.response) {
              if (result.feedback) {
                feedbackResults.push(result.response);
              } else if (sourceMessage) {
                const channel = sourceMessage.channel;
                if (
                  'send' in channel &&
                  typeof (channel as { send?: unknown }).send === 'function'
                ) {
                  await (channel as { send: (content: string) => Promise<unknown> }).send(
                    result.response
                  );
                }
              }
            }
          }
          continue; // i 已经指向下一个命令行
        } else {
          // 第一行有文本 → 继续吸收后续行（直到下一个命令行）
          const bodyLines: string[] = [firstLineContent];
          let inBodyCodeBlock2 = false;
          i++;
          while (i < lines.length) {
            const bodyLine = lines[i];
            if (bodyLine.trim().startsWith('```')) {
              inBodyCodeBlock2 = !inBodyCodeBlock2;
            }
            if (
              !inBodyCodeBlock2 &&
              (bodyLine.trim().startsWith('!discord ') || bodyLine.trim().startsWith('!schedule'))
            ) {
              break;
            }
            bodyLines.push(bodyLine);
            i++;
          }
          const fullMessage = bodyLines.join('\n').trimEnd();
          const commandText = `!discord send <#${sendMatch[1]}> ${fullMessage}`;
          console.log(
            `[xangi] Processing discord command from response: ${commandText.slice(0, 50)}...`
          );
          const result = await handleDiscordCommand(commandText, sourceMessage, fallbackChannelId);
          if (result.handled && result.response) {
            if (result.feedback) {
              feedbackResults.push(result.response);
            } else if (sourceMessage) {
              const channel = sourceMessage.channel;
              if ('send' in channel && typeof (channel as { send?: unknown }).send === 'function') {
                await (channel as { send: (content: string) => Promise<unknown> }).send(
                  result.response
                );
              }
            }
          }
          continue;
        }
      }

      // !discord edit 的多行支持
      const editMatch = trimmed.match(/^!discord\s+edit\s+(\S+)\s*([\s\S]*)/);
      if (editMatch) {
        const editTarget = editMatch[1];
        const firstLineContent = editMatch[2] ?? '';
        const bodyLines: string[] = firstLineContent ? [firstLineContent] : [];
        let inEditCodeBlock = false;
        i++;
        while (i < lines.length) {
          const bodyLine = lines[i];
          if (bodyLine.trim().startsWith('```')) {
            inEditCodeBlock = !inEditCodeBlock;
          }
          if (
            !inEditCodeBlock &&
            (bodyLine.trim().startsWith('!discord ') || bodyLine.trim().startsWith('!schedule'))
          ) {
            break;
          }
          bodyLines.push(bodyLine);
          i++;
        }
        const fullContent = bodyLines.join('\n').trim();
        if (fullContent) {
          const commandText = `!discord edit ${editTarget} ${fullContent}`;
          console.log(
            `[xangi] Processing discord edit from response: ${commandText.slice(0, 50)}...`
          );
          const result = await handleDiscordCommand(commandText, sourceMessage, fallbackChannelId);
          if (result.handled && result.response) {
            if (result.feedback) {
              feedbackResults.push(result.response);
            } else if (sourceMessage) {
              const channel = sourceMessage.channel;
              if ('send' in channel && typeof (channel as { send?: unknown }).send === 'function') {
                await (channel as { send: (content: string) => Promise<unknown> }).send(
                  result.response
                );
              }
            }
          }
        }
        continue;
      }

      // 其他 !discord 命令（channels, search, history, delete）
      if (trimmed.startsWith('!discord ')) {
        console.log(`[xangi] Processing discord command from response: ${trimmed.slice(0, 50)}...`);
        const result = await handleDiscordCommand(trimmed, sourceMessage, fallbackChannelId);
        if (result.handled && result.response) {
          if (result.feedback) {
            feedbackResults.push(result.response);
          } else if (sourceMessage) {
            const channel = sourceMessage.channel;
            if ('send' in channel && typeof (channel as { send?: unknown }).send === 'function') {
              await (channel as { send: (content: string) => Promise<unknown> }).send(
                result.response
              );
            }
          }
        }
      }

      // !schedule 命令（无参数时也显示列表，需要 sourceMessage）
      if (sourceMessage && (trimmed === '!schedule' || trimmed.startsWith('!schedule '))) {
        console.log(
          `[xangi] Processing schedule command from response: ${trimmed.slice(0, 50)}...`
        );
        await executeScheduleFromResponse(trimmed, sourceMessage, scheduler, config.scheduler);
      }

      i++;
    }

    return feedbackResults;
  }

  // 处理 Discord API 错误防止进程崩溃
  client.on('error', (error) => {
    console.error('[xangi] Discord client error:', error.message);
  });

  // 频道级别的处理锁
  const processingChannels = new Set<string>();

  // 消息处理
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    const isMentioned = message.mentions.has(client.user!);
    const isDM = !message.guild;
    const isAutoReplyChannel =
      config.discord.autoReplyChannels?.includes(message.channel.id) ?? false;

    if (!isMentioned && !isDM && !isAutoReplyChannel) return;

    // 同一频道正在处理中则忽略（提及除外）
    if (!isMentioned && processingChannels.has(message.channel.id)) {
      console.log(`[xangi] Skipping message in busy channel: ${message.channel.id}`);
      return;
    }

    if (
      !config.discord.allowedUsers?.includes('*') &&
      !config.discord.allowedUsers?.includes(message.author.id)
    ) {
      console.log(`[xangi] Unauthorized user: ${message.author.id} (${message.author.tag})`);
      return;
    }

    let prompt = message.content
      .replace(/<@[!&]?\d+>/g, '') // 只删除用户提及（保留频道提及）
      .replace(/\s+/g, ' ')
      .trim();

    // 跳过设置（在添加回复源和链接展开之前判断）
    // 使用 !skip 前缀可以临时进入跳过模式
    let skipPermissions = config.agent.config.skipPermissions ?? false;

    if (prompt.startsWith('!skip')) {
      skipPermissions = true;
      prompt = prompt.replace(/^!skip\s*/, '').trim();
    }

    // 处理 !discord 命令
    if (prompt.startsWith('!discord')) {
      const result = await handleDiscordCommand(prompt, message);
      if (result.handled) {
        if (result.feedback && result.response) {
          // feedback 结果注入到代理的上下文中
          // → 将原命令和结果合并后送入提示词
          prompt = `用户执行了“${prompt}”。以下是结果。请基于此信息回复用户。\n\n${result.response}`;
          // 继续流到 processPrompt（见下方）
        } else {
          if (result.response && 'send' in message.channel) {
            await message.channel.send(result.response);
          }
          return;
        }
      }
    }

    // 处理 !schedule 命令
    if (prompt.startsWith('!schedule')) {
      await handleScheduleMessage(message, prompt, scheduler, config.scheduler);
      return;
    }

    // 从 Discord 链接获取消息内容
    prompt = await fetchDiscordLinkContent(prompt);

    // 获取回复源消息并添加到提示词中
    const replyContent = await fetchReplyContent(message);
    if (replyContent) {
      prompt = replyContent + prompt;
    }

    // 为频道提及添加ID注释（在展开之前执行）
    prompt = annotateChannelMentions(prompt);

    // 从频道提及获取最新消息
    prompt = await fetchChannelMessages(prompt);

    // 下载附件文件
    const attachmentPaths: string[] = [];
    if (message.attachments.size > 0) {
      for (const [, attachment] of message.attachments) {
        try {
          const filePath = await downloadFile(attachment.url, attachment.name || 'file');
          attachmentPaths.push(filePath);
        } catch (err) {
          console.error(`[xangi] Failed to download attachment: ${attachment.name}`, err);
        }
      }
    }

    // 既没有文本也没有附件则跳过
    if (!prompt && attachmentPaths.length === 0) return;

    // 将附件信息添加到提示词中
    prompt = buildPromptWithAttachments(
      prompt || '请查看附件',
      attachmentPaths
    );

    const channelId = message.channel.id;

    // 将频道主题注入到提示词中
    if (config.discord.injectChannelTopic !== false) {
      const channel = message.channel;
      if ('topic' in channel && channel.topic) {
        prompt += `\n\n[频道规则（必须遵守）]\n${channel.topic}`;
      }
    }

    // 将时间戳注入到提示词开头
    if (config.discord.injectTimestamp !== false) {
      const d = new Date();
      const now = d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      const day = d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', weekday: 'short' });
      prompt = `[当前时间: ${now}(${day})]\n${prompt}`;
    }

    processingChannels.add(channelId);
    try {
      const result = await processPrompt(
        message,
        agentRunner,
        prompt,
        skipPermissions,
        channelId,
        config
      );

      // 从 AI 的响应中检测并执行 !discord 命令
      if (result) {
        const feedbackResults = await handleDiscordCommandsInResponse(result, message);

        // 如果有反馈结果则重新注入到代理
        if (feedbackResults.length > 0) {
          const feedbackPrompt = `你执行的命令结果已返回。请基于此信息，结合原对话上下文回复用户。\n\n${feedbackResults.join('\n\n')}`;
          console.log(`[xangi] Re-injecting ${feedbackResults.length} feedback result(s) to agent`);
          const feedbackResult = await processPrompt(
            message,
            agentRunner,
            feedbackPrompt,
            skipPermissions,
            channelId,
            config
          );
          // 如果重新注入后的响应中还有命令则处理（但只递归一次）
          if (feedbackResult) {
            await handleDiscordCommandsInResponse(feedbackResult, message);
          }
        }
      }
    } finally {
      processingChannels.delete(channelId);
    }
  });

  // 启动 Discord 机器人
  if (config.discord.enabled) {
    await client.login(config.discord.token);
    console.log('[xangi] Discord bot started');

    // 向调度器注册 Discord 发送函数
    scheduler.registerSender('discord', async (channelId, msg) => {
      const channel = await client.channels.fetch(channelId);
      if (channel && 'send' in channel) {
        await (channel as { send: (content: string) => Promise<unknown> }).send(msg);
      }
    });

    // 向调度器注册代理执行函数
    scheduler.registerAgentRunner('discord', async (prompt, channelId) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) {
        throw new Error(`Channel not found: ${channelId}`);
      }

      // 先直接执行提示词中的 !discord send 命令
      // （如果传给 AI，命令会包含在响应中而不被执行）
      const promptCommands = extractDiscordSendFromPrompt(prompt);
      for (const cmd of promptCommands.commands) {
        console.log(`[scheduler] Executing discord command from prompt: ${cmd.slice(0, 80)}...`);
        await handleDiscordCommand(cmd, undefined, channelId);
      }

      // 如果还有 !discord send 以外的文本则传给 AI
      const remainingPrompt = promptCommands.remaining.trim();
      if (!remainingPrompt) {
        // 提示词中只有命令，不需要 AI
        console.log('[scheduler] Prompt contained only discord commands, skipping agent');
        return promptCommands.commands.map((c) => `✅ ${c.slice(0, 50)}`).join('\n');
      }

      // 发送“思考中”消息
      const thinkingMsg = await (
        channel as {
          send: (content: string) => Promise<{ edit: (content: string) => Promise<unknown> }>;
        }
      ).send('🤔 思考中...');

      try {
        // 将时间戳注入到提示词开头
        let agentPrompt = remainingPrompt;
        if (config.discord.injectTimestamp !== false) {
          const d = new Date();
          const now = d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
          const day = d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', weekday: 'short' });
          agentPrompt = `[当前时间: ${now}(${day})]\n${agentPrompt}`;
        }

        // 调度器每次都使用新会话（无状态）
        const schedAppSessionId = ensureSession(channelId, {
          platform: 'discord',
          scope: 'scheduler',
        });
        const { result, sessionId: newSessionId } = await agentRunner.run(agentPrompt, {
          skipPermissions: config.agent.config.skipPermissions ?? false,
          sessionId: undefined,
          channelId,
          appSessionId: schedAppSessionId,
        });

        // 调度器的会话保存在 scheduler 作用域
        setSession(channelId, newSessionId, 'scheduler');

        // 处理 AI 响应中的 !discord 命令（无 sourceMessage，使用 channelId 作为回退）
        const feedbackResults = await handleDiscordCommandsInResponse(result, undefined, channelId);

        // 如果有反馈结果则重新注入到代理
        if (feedbackResults.length > 0) {
          const feedbackPrompt = `你执行的命令结果已返回。请基于此信息，结合原对话上下文回复用户。\n\n${feedbackResults.join('\n\n')}`;
          console.log(
            `[scheduler] Re-injecting ${feedbackResults.length} feedback result(s) to agent`
          );
          const feedbackSession = getSession(channelId);
          const feedbackRun = await agentRunner.run(feedbackPrompt, {
            skipPermissions: config.agent.config.skipPermissions ?? false,
            sessionId: feedbackSession,
            channelId,
            appSessionId: schedAppSessionId,
          });
          setSession(channelId, feedbackRun.sessionId, 'scheduler');
          // 如果重新注入后的响应中还有命令则处理
          await handleDiscordCommandsInResponse(feedbackRun.result, undefined, channelId);
        }

        // 发送结果
        const filePaths = extractFilePaths(result);
        const displayText = filePaths.length > 0 ? stripFilePaths(result) : result;

        // === 使用分隔符显式分割（用于在单个响应中包含多个帖子，如 content-digest）
        // LLM 可能会在前后添加空白或多余换行，使用正则宽松匹配
        const SEPARATOR_REGEX = /\n\s*===\s*\n/;
        const messageParts = SEPARATOR_REGEX.test(displayText)
          ? displayText
              .split(SEPARATOR_REGEX)
              .map((p) => p.trim())
              .filter(Boolean)
          : [displayText];

        // 第一个部分编辑现有的 thinkingMsg 发送
        const firstChunks = splitMessage(messageParts[0], DISCORD_SAFE_LENGTH);
        await thinkingMsg.edit(firstChunks[0] || '✅');
        // 记录最后发送的消息ID（通过调度器）
        if ('id' in thinkingMsg) {
          lastSentMessageIds.set(channelId, (thinkingMsg as { id: string }).id);
        }
        const ch = channel as { send: (content: string) => Promise<unknown> };
        // 第一个部分的剩余块
        for (let i = 1; i < firstChunks.length; i++) {
          await ch.send(firstChunks[i]);
        }
        // 第二及以后的部分作为新消息发送
        for (let p = 1; p < messageParts.length; p++) {
          const chunks = splitMessage(messageParts[p], DISCORD_SAFE_LENGTH);
          for (const chunk of chunks) {
            await ch.send(chunk);
          }
        }

        if (filePaths.length > 0) {
          await (
            channel as { send: (options: { files: { attachment: string }[] }) => Promise<unknown> }
          ).send({
            files: filePaths.map((fp) => ({ attachment: fp })),
          });
        }

        return result;
      } catch (error) {
        if (error instanceof Error && error.message === 'Request cancelled by user') {
          await thinkingMsg.edit('🛑 已停止任务');
        } else {
          const errorMsg = error instanceof Error ? error.message : String(error);
          let errorDetail: string;
          if (errorMsg.includes('timed out')) {
            errorDetail = `⏱️ 超时了`;
          } else if (errorMsg.includes('Process exited unexpectedly')) {
            errorDetail = `💥 AI进程意外终止`;
          } else if (errorMsg.includes('Circuit breaker')) {
            errorDetail = '🔌 AI进程暂时暂停中';
          } else {
            errorDetail = `❌ 错误: ${errorMsg.slice(0, 200)}`;
          }
          await thinkingMsg.edit(errorDetail);
        }
        throw error;
      }
    });
  }

  // 启动 Slack 机器人
  if (config.slack.enabled) {
    await startSlackBot({
      config,
      agentRunner,
      skills,
      reloadSkills: () => {
        skills = loadSkills(workdir);
        return skills;
      },
      scheduler,
    });
    console.log('[xangi] Slack bot started');
  }

  const webChatEnabled = process.env.WEB_CHAT_ENABLED === 'true';
  if (!config.discord.enabled && !config.slack.enabled && !webChatEnabled) {
    console.error(
      '[xangi] No chat platform enabled. Set DISCORD_TOKEN, SLACK_BOT_TOKEN/SLACK_APP_TOKEN, or WEB_CHAT_ENABLED=true'
    );
    process.exit(1);
  }

  // 启动调度器的所有任务
  scheduler.startAll(config.scheduler);

  // 关闭时停止调度器
  const shutdown = () => {
    console.log('[xangi] Shutting down scheduler...');
    scheduler.stopAll();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  skills: Skill[]
): Promise<void> {
  const focusedValue = interaction.options.getFocused().toLowerCase();

  const filtered = skills
    .filter(
      (skill) =>
        skill.name.toLowerCase().includes(focusedValue) ||
        skill.description.toLowerCase().includes(focusedValue)
    )
    .slice(0, 25) // Discord 限制：最多25条
    .map((skill) => ({
      name: `${skill.name} - ${skill.description.slice(0, 50)}`,
      value: skill.name,
    }));

  await interaction.respond(filtered);
}

async function handleSkill(
  interaction: ChatInputCommandInteraction,
  agentRunner: AgentRunner,
  config: ReturnType<typeof loadConfig>,
  channelId: string
) {
  const skillName = interaction.options.getString('name', true);
  const args = interaction.options.getString('args') || '';
  const skipPermissions = config.agent.config.skipPermissions ?? false;

  await interaction.deferReply();

  try {
    const prompt = `请执行技能“${skillName}”。${args ? `参数: ${args}` : ''}`;
    const sessionId = getSession(channelId);
    const appSessionId = ensureSession(channelId, { platform: 'discord' });
    const { result, sessionId: newSessionId } = await agentRunner.run(prompt, {
      skipPermissions,
      sessionId,
      channelId,
      appSessionId,
    });

    setSession(channelId, newSessionId);
    const chunks = splitMessage(result, DISCORD_SAFE_LENGTH);
    await interaction.editReply(chunks[0] || '✅');
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp(chunks[i]);
    }
  } catch (error) {
    console.error('[xangi] Error:', error);
    await interaction.editReply('发生错误');
  }
}

async function handleSkillCommand(
  interaction: ChatInputCommandInteraction,
  agentRunner: AgentRunner,
  config: ReturnType<typeof loadConfig>,
  channelId: string,
  skillName: string
) {
  const args = interaction.options.getString('args') || '';
  const skipPermissions = config.agent.config.skipPermissions ?? false;

  await interaction.deferReply();

  try {
    const prompt = `请执行技能“${skillName}”。${args ? `参数: ${args}` : ''}`;
    const sessionId = getSession(channelId);
    const appSessionId = ensureSession(channelId, { platform: 'discord' });
    const { result, sessionId: newSessionId } = await agentRunner.run(prompt, {
      skipPermissions,
      sessionId,
      channelId,
      appSessionId,
    });

    setSession(channelId, newSessionId);
    const chunks = splitMessage(result, DISCORD_SAFE_LENGTH);
    await interaction.editReply(chunks[0] || '✅');
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp(chunks[i]);
    }
  } catch (error) {
    console.error('[xangi] Error:', error);
    await interaction.editReply('发生错误');
  }
}

/**
 * 从文本中提取 !discord send 命令，并返回剩余文本
 * 用于从调度器提示词中分离命令
 * 忽略代码块内的命令
 */
function extractDiscordSendFromPrompt(text: string): {
  commands: string[];
  remaining: string;
} {
  const lines = text.split('\n');
  const commands: string[] = [];
  const remainingLines: string[] = [];
  let inCodeBlock = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      remainingLines.push(line);
      i++;
      continue;
    }

    if (inCodeBlock) {
      remainingLines.push(line);
      i++;
      continue;
    }

    const trimmed = line.trim();
    const sendMatch = trimmed.match(/^!discord\s+send\s+<#(\d+)>\s*(.*)/);
    if (sendMatch) {
      const firstLineContent = sendMatch[2] ?? '';
      if (firstLineContent.trim() === '') {
        // 隐式多行：吸收到下一个命令行
        const bodyLines: string[] = [];
        let inBodyCodeBlock = false;
        i++;
        while (i < lines.length) {
          const bodyLine = lines[i];
          if (bodyLine.trim().startsWith('```')) {
            inBodyCodeBlock = !inBodyCodeBlock;
          }
          if (
            !inBodyCodeBlock &&
            (bodyLine.trim().startsWith('!discord ') || bodyLine.trim().startsWith('!schedule'))
          ) {
            break;
          }
          bodyLines.push(bodyLine);
          i++;
        }
        const fullMessage = bodyLines.join('\n').trim();
        if (fullMessage) {
          commands.push(`!discord send <#${sendMatch[1]}> ${fullMessage}`);
        }
        continue;
      } else {
        // 第一行有文本 → 继续吸收后续行
        const bodyLines2: string[] = [firstLineContent];
        let inBodyCodeBlock2 = false;
        i++;
        while (i < lines.length) {
          const bodyLine = lines[i];
          if (bodyLine.trim().startsWith('```')) {
            inBodyCodeBlock2 = !inBodyCodeBlock2;
          }
          if (
            !inBodyCodeBlock2 &&
            (bodyLine.trim().startsWith('!discord ') || bodyLine.trim().startsWith('!schedule'))
          ) {
            break;
          }
          bodyLines2.push(bodyLine);
          i++;
        }
        const fullMessage2 = bodyLines2.join('\n').trimEnd();
        commands.push(`!discord send <#${sendMatch[1]}> ${fullMessage2}`);
        continue;
      }
    }

    remainingLines.push(line);
    i++;
  }

  return { commands, remaining: remainingLines.join('\n') };
}

/**
 * 从显示文本中移除命令行（代码块内的保留）
 * 移除以 SYSTEM_COMMAND:, !discord, !schedule 开头的行
 * 也移除 !discord send 的多行消息（后续行）
 */
function stripCommandsFromDisplay(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      i++;
      continue;
    }

    if (inCodeBlock) {
      result.push(line);
      i++;
      continue;
    }

    const trimmed = line.trim();

    // 移除 SYSTEM_COMMAND: 行
    if (trimmed.startsWith('SYSTEM_COMMAND:')) {
      i++;
      continue;
    }

    // !discord send 的多行支持：移除命令行和后续行
    const sendMatch = trimmed.match(/^!discord\s+send\s+<#\d+>\s*(.*)/);
    if (sendMatch) {
      // 同时移除后续行（直到下一个命令行）
      i++;
      let inBodyCodeBlock = false;
      while (i < lines.length) {
        const bodyLine = lines[i];
        if (bodyLine.trim().startsWith('```')) {
          inBodyCodeBlock = !inBodyCodeBlock;
        }
        if (
          !inBodyCodeBlock &&
          (bodyLine.trim().startsWith('!discord ') || bodyLine.trim().startsWith('!schedule'))
        ) {
          break;
        }
        i++;
      }
      continue;
    }

    // 移除其他 !discord 命令行
    if (trimmed.startsWith('!discord ')) {
      i++;
      continue;
    }

    // 移除 !schedule 命令行
    if (trimmed === '!schedule' || trimmed.startsWith('!schedule ')) {
      i++;
      continue;
    }

    result.push(line);
    i++;
  }

  return result.join('\n').trim();
}

async function processPrompt(
  message: Message,
  agentRunner: AgentRunner,
  prompt: string,
  skipPermissions: boolean,
  channelId: string,
  config: ReturnType<typeof loadConfig>
): Promise<string | null> {
  let replyMessage: Message | null = null;
  const toolHistory: string[] = []; // 工具执行历史（用于 stop 时参考，放在函数作用域）
  let lastStreamedText = ''; // 用于在错误时保留部分文本，放在函数作用域
  try {
    // 将频道和用户信息添加到提示词中
    const channelName =
      'name' in message.channel ? (message.channel as { name: string }).name : null;
    const userInfo = `[发言者: ${message.author.displayName ?? message.author.username} (ID: ${message.author.id})]`;
    if (channelName) {
      prompt = `[平台: Discord]\n[频道: #${channelName} (ID: ${channelId})]\n${userInfo}\n${prompt}`;
    } else {
      prompt = `${userInfo}\n${prompt}`;
    }

    console.log(`[xangi] Processing message in channel ${channelId}`);
    await message.react('👀').catch(() => {});

    const sessionId = getSession(channelId);
    const appSessionId = ensureSession(channelId, { platform: 'discord' });
    const useStreaming = config.discord.streaming ?? true;
    const showThinking = config.discord.showThinking ?? true;

    // 如果是 !skip 前缀，使用一次性运行器
    // （persistent-runner 无法在进程启动后改变权限设置）
    const defaultSkip = config.agent.config.skipPermissions ?? false;
    const needsSkipRunner = skipPermissions && !defaultSkip;
    const runner: AgentRunner = needsSkipRunner
      ? new ClaudeCodeRunner(config.agent.config)
      : agentRunner;

    if (needsSkipRunner) {
      console.log(`[xangi] Using one-shot skip runner for channel ${channelId}`);
    }

    // 发送初始消息
    const showButtons = config.discord.showButtons ?? true;
    replyMessage = await message.reply({
      content: '🤔 思考中.',
      ...(showButtons && { components: [createStopButton()] }),
    });

    let result: string;
    let newSessionId: string;

    if (useStreaming && showThinking && !needsSkipRunner) {
      // 流式 + 思考显示模式（仅 persistent-runner）
      let lastUpdateTime = 0;
      let pendingUpdate = false;
      let firstTextReceived = false;

      // 在收到第一个文本之前显示思考动画
      let dotCount = 1;
      const thinkingInterval = setInterval(() => {
        if (firstTextReceived) return;
        dotCount = (dotCount % 3) + 1;
        const dots = '.'.repeat(dotCount);
        const toolDisplay = toolHistory.length > 0 ? '\n' + toolHistory.join('\n') : '';
        replyMessage!.edit(`🤔 思考中${dots}${toolDisplay}`).catch(() => {});
      }, 1000);

      let streamResult: { result: string; sessionId: string };
      try {
        streamResult = await agentRunner.runStream(
          prompt,
          {
            onText: (_chunk, fullText) => {
              lastStreamedText = fullText;
              if (!firstTextReceived) {
                firstTextReceived = true;
                clearInterval(thinkingInterval);
              }
              const now = Date.now();
              if (now - lastUpdateTime >= STREAM_UPDATE_INTERVAL_MS && !pendingUpdate) {
                pendingUpdate = true;
                lastUpdateTime = now;
                replyMessage!
                  .edit((fullText + ' ▌').slice(0, DISCORD_MAX_LENGTH))
                  .catch((err) => {
                    console.error('[xangi] Failed to edit message:', err.message);
                  })
                  .finally(() => {
                    pendingUpdate = false;
                  });
              }
            },
            onToolUse: (toolName, toolInput) => {
              // 添加到工具执行历史
              const inputSummary = formatToolInput(toolName, toolInput);
              toolHistory.push(`🔧 ${toolName}${inputSummary}`);
              if (!firstTextReceived) {
                const toolDisplay = toolHistory.join('\n');
                replyMessage!.edit(`🤔 思考中...\n${toolDisplay}`).catch(() => {});
              }
            },
          },
          {
            skipPermissions,
            sessionId,
            channelId,
            appSessionId,
          }
        );
      } finally {
        clearInterval(thinkingInterval);
      }
      result = streamResult.result;
      newSessionId = streamResult.sessionId;
    } else {
      // 非流式 或 一次性跳过运行器
      let dotCount = 1;
      const thinkingInterval = setInterval(() => {
        dotCount = (dotCount % 3) + 1;
        const dots = '.'.repeat(dotCount);
        replyMessage!.edit(`🤔 思考中${dots}`).catch(() => {});
      }, 1000);

      try {
        const runResult = await runner.run(prompt, {
          skipPermissions,
          sessionId,
          channelId,
          appSessionId,
        });
        result = runResult.result;
        newSessionId = runResult.sessionId;
      } finally {
        clearInterval(thinkingInterval);
      }
    }

    setSession(channelId, newSessionId);
    incrementMessageCount(appSessionId);
    // 第一条消息自动设置标题（略）
    console.log(
      `[xangi] Response length: ${result.length}, session: ${newSessionId.slice(0, 8)}...`
    );

    // 提取文件路径并发送附件
    const filePaths = extractFilePaths(result);
    const displayText = filePaths.length > 0 ? stripFilePaths(result) : result;

    // 从显示文本中移除 SYSTEM_COMMAND: 行和 !discord / !schedule 命令行
    // 代码块内的命令保留（因为是显示用文本，不删除）
    const cleanText = stripCommandsFromDisplay(displayText);

    // === 使用分隔符显式分割（用于在单个响应中包含多个帖子，如 content-digest）
    // LLM 可能会在前后添加空白或多余换行，使用正则宽松匹配
    const SEPARATOR_REGEX = /\n\s*===\s*\n/;
    const messageParts = SEPARATOR_REGEX.test(cleanText)
      ? cleanText
          .split(SEPARATOR_REGEX)
          .map((p) => p.trim())
          .filter(Boolean)
      : [cleanText];

    // 第一个部分编辑现有的 replyMessage 发送
    const firstChunks = splitMessage(messageParts[0], DISCORD_SAFE_LENGTH);
    await replyMessage!.edit({
      content: firstChunks[0] || '✅',
      ...(showButtons && { components: [createCompletedButtons()] }),
    });
    // 记录最后发送的消息ID
    if (replyMessage) {
      lastSentMessageIds.set(message.channel.id, replyMessage.id);
    }
    if ('send' in message.channel) {
      const channel = message.channel as unknown as {
        send: (content: string) => Promise<unknown>;
      };
      // 第一个部分的剩余块
      for (let i = 1; i < firstChunks.length; i++) {
        await channel.send(firstChunks[i]);
      }
      // 第二及以后的部分作为新消息发送
      for (let p = 1; p < messageParts.length; p++) {
        const chunks = splitMessage(messageParts[p], DISCORD_SAFE_LENGTH);
        for (const chunk of chunks) {
          await channel.send(chunk);
        }
      }
    }

    // 从 AI 的响应中检测并执行 SYSTEM_COMMAND:
    handleSettingsFromResponse(result);

    if (filePaths.length > 0 && 'send' in message.channel) {
      try {
        await (
          message.channel as unknown as {
            send: (options: { files: { attachment: string }[] }) => Promise<unknown>;
          }
        ).send({
          files: filePaths.map((fp) => ({ attachment: fp })),
        });
        console.log(`[xangi] Sent ${filePaths.length} file(s) to Discord`);
      } catch (err) {
        console.error('[xangi] Failed to send files:', err);
      }
    }

    // 返回 AI 的响应（用于 !discord 命令处理）
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === 'Request cancelled by user') {
      console.log('[xangi] Request cancelled by user');
      const toolDisplay = toolHistory.length > 0 ? '\n' + toolHistory.join('\n') + '\n' : '';
      const prefix = lastStreamedText ? lastStreamedText + '\n\n' : '';
      await replyMessage
        ?.edit({
          content: `${prefix}🛑 已停止${toolDisplay}`.slice(0, DISCORD_MAX_LENGTH),
          components: [],
        })
        .catch(() => {});
      return null;
    }
    console.error('[xangi] Error:', error);

    // 判断错误类型并生成详细信息
    const errorMsg = error instanceof Error ? error.message : String(error);
    let errorDetail: string;
    if (errorMsg.includes('timed out')) {
      errorDetail = `⏱️ 超时了（${Math.round((config.agent.config.timeoutMs ?? 300000) / 1000)}秒）`;
    } else if (errorMsg.includes('Process exited unexpectedly')) {
      errorDetail = `💥 AI进程意外终止: ${errorMsg}`;
    } else if (errorMsg.includes('Circuit breaker')) {
      errorDetail =
        '🔌 AI进程因连续崩溃而暂时暂停。请稍后重试';
    } else {
      errorDetail = `❌ 发生错误: ${errorMsg.slice(0, 200)}`;
    }

    // 显示错误详情（保留中间文本和工具历史）
    const toolDisplay = toolHistory.length > 0 ? '\n' + toolHistory.join('\n') : '';
    const prefix = lastStreamedText ? lastStreamedText + '\n\n' : '';
    const errorMessage = `${prefix}${errorDetail}${toolDisplay}`.slice(0, DISCORD_MAX_LENGTH);
    if (replyMessage) {
      await replyMessage.edit({ content: errorMessage, components: [] }).catch(() => {});
    } else {
      await message.reply(errorMessage).catch(() => {});
    }

    // 错误后向代理自动发送跟进（超时和断路器时除外）
    // 超时后的跟进只会给损坏的会话增加更多负担，
    // 导致再次超时→断路器触发→频道长时间锁定
    if (!errorMsg.includes('Circuit breaker') && !errorMsg.includes('timed out')) {
      try {
        console.log('[xangi] Sending error follow-up to agent');
        const sessionId = getSession(channelId);
        if (sessionId) {
          const followUpPrompt =
            '刚才的处理因错误（超时等）中断了。请简要报告已进行的作业内容和当前状态。';
          const followUpAppId = getActiveSessionId(channelId);
          const followUpResult = await agentRunner.run(followUpPrompt, {
            skipPermissions,
            sessionId,
            channelId,
            appSessionId: followUpAppId,
          });
          if (followUpResult.result) {
            setSession(channelId, followUpResult.sessionId);
            const followUpText = followUpResult.result.slice(0, DISCORD_SAFE_LENGTH);
            if ('send' in message.channel) {
              await (
                message.channel as unknown as {
                  send: (content: string) => Promise<unknown>;
                }
              ).send(`📋 **错误前的作业报告:**\n${followUpText}`);
            }
          }
        }
      } catch (followUpError) {
        console.error('[xangi] Error follow-up failed:', followUpError);
      }
    }

    return null;
  } finally {
    // 删除 👀 反应
    await message.reactions.cache
      .find((r) => r.emoji.name === '👀')
      ?.users.remove(message.client.user?.id)
      .catch((err) => {
        console.error('[xangi] Failed to remove 👀 reaction:', err.message || err);
      });
  }
}

/**
 * 从 AI 的响应中检测并执行 SYSTEM_COMMAND:
 * 格式: SYSTEM_COMMAND:restart / SYSTEM_COMMAND:set key=value
 */
function handleSettingsFromResponse(text: string): void {
  const commands = text.match(/^SYSTEM_COMMAND:(.+)$/gm);
  if (!commands) return;

  for (const cmd of commands) {
    const action = cmd.replace('SYSTEM_COMMAND:', '').trim();

    if (action === 'restart') {
      const settings = loadSettings();
      if (!settings.autoRestart) {
        console.log('[xangi] Restart requested but autoRestart is disabled');
        continue;
      }
      console.log('[xangi] Restart requested by agent, restarting in 1s...');
      setTimeout(() => process.exit(0), 1000);
      return;
    }

    const setMatch = action.match(/^set\s+(\w+)=(.*)/);
    if (setMatch) {
      const [, key, value] = setMatch;
      if (key === 'autoRestart') {
        const enabled = value === 'true';
        saveSettings({ autoRestart: enabled });
        console.log(`[xangi] autoRestart ${enabled ? 'enabled' : 'disabled'} by agent`);
      }
    }
  }
}

// ─── 调度处理程序 ──────────────────────────────────────────────

async function handleScheduleCommand(
  interaction: ChatInputCommandInteraction,
  scheduler: Scheduler,
  schedulerConfig?: { enabled: boolean; startupEnabled: boolean }
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const channelId = interaction.channelId;

  switch (subcommand) {
    case 'add': {
      const input = interaction.options.getString('input', true);
      const parsed = parseScheduleInput(input);
      if (!parsed) {
        await interaction.reply({
          content:
            '❌ 无法解析输入\n\n' +
            '**支持格式:**\n' +
            '• `30分钟后 消息` — 相对时间\n' +
            '• `15:00 消息` — 指定时间\n' +
            '• `每天 9:00 消息` — 每天定时\n' +
            '• `每周一 10:00 消息` — 每周\n' +
            '• `cron 0 9 * * * 消息` — cron表达式',
          ephemeral: true,
        });
        return;
      }

      try {
        const targetChannel = parsed.targetChannelId || channelId;
        const schedule = scheduler.add({
          ...parsed,
          channelId: targetChannel,
          platform: 'discord' as Platform,
        });

        const channelInfo = parsed.targetChannelId ? ` → <#${parsed.targetChannelId}>` : '';
        const typeLabel = getTypeLabel(schedule.type, {
          expression: schedule.expression,
          runAt: schedule.runAt,
          channelInfo,
        });

        await interaction.reply(
          `✅ 已添加调度\n\n${typeLabel}\n📝 ${schedule.message}\n🆔 \`${schedule.id}\``
        );
      } catch (error) {
        await interaction.reply({
          content: `❌ ${error instanceof Error ? error.message : '发生错误'}`,
          ephemeral: true,
        });
      }
      return;
    }

    case 'list': {
      // 显示所有调度（不按频道过滤）
      const schedules = scheduler.list();
      const content = formatScheduleList(schedules, schedulerConfig);
      if (content.length <= DISCORD_MAX_LENGTH) {
        await interaction.reply(content.replaceAll(SCHEDULE_SEPARATOR, ''));
      } else {
        const chunks = splitScheduleContent(content, DISCORD_SAFE_LENGTH);
        await interaction.reply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp(chunks[i]);
        }
      }
      return;
    }

    case 'remove': {
      const id = interaction.options.getString('id', true);
      const removed = scheduler.remove(id);
      await interaction.reply(
        removed ? `🗑️ 已删除调度 \`${id}\`` : `❌ 未找到 ID \`${id}\``
      );
      return;
    }

    case 'toggle': {
      const id = interaction.options.getString('id', true);
      const schedule = scheduler.toggle(id);
      if (schedule) {
        const status = schedule.enabled ? '✅ 已启用' : '⏸️ 已禁用';
        await interaction.reply(`${status}: \`${id}\``);
      } else {
        await interaction.reply(`❌ 未找到 ID \`${id}\``);
      }
      return;
    }
  }
}

async function handleScheduleMessage(
  message: Message,
  prompt: string,
  scheduler: Scheduler,
  schedulerConfig?: { enabled: boolean; startupEnabled: boolean }
): Promise<void> {
  const args = prompt.replace(/^!schedule\s*/, '').trim();
  const channelId = message.channel.id;

  // !schedule (无参数) or !schedule list → 列表（显示全部）
  if (!args || args === 'list') {
    const schedules = scheduler.list();
    const content = formatScheduleList(schedules, schedulerConfig);
    if (content.length <= DISCORD_MAX_LENGTH) {
      await message.reply(content.replaceAll(SCHEDULE_SEPARATOR, ''));
    } else {
      const chunks = splitScheduleContent(content, DISCORD_SAFE_LENGTH);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    }
    return;
  }

  // !schedule remove <id|编号> [编号2] [编号3] ...
  if (args.startsWith('remove ') || args.startsWith('delete ') || args.startsWith('rm ')) {
    const parts = args.split(/\s+/).slice(1).filter(Boolean);
    if (parts.length === 0) {
      await message.reply('用法: `!schedule remove <ID 或 编号> [编号2] ...`');
      return;
    }

    const schedules = scheduler.list();
    const deletedIds: string[] = [];
    const errors: string[] = [];

    // 按编号从大到小排序（防止删除时的偏移问题）
    const targets = parts
      .map((p) => {
        const num = parseInt(p, 10);
        if (!isNaN(num) && num > 0 && !p.startsWith('sch_')) {
          if (num > schedules.length) {
            errors.push(`编号 ${num} 超出范围`);
            return null;
          }
          return { index: num, id: schedules[num - 1].id };
        }
        return { index: 0, id: p };
      })
      .filter((t): t is { index: number; id: string } => t !== null)
      .sort((a, b) => b.index - a.index); // 从大到小删除

    for (const target of targets) {
      if (scheduler.remove(target.id)) {
        deletedIds.push(target.id);
      } else {
        errors.push(`未找到 ID ${target.id}`);
      }
    }

    const remaining = scheduler.list();
    let response = '';
    if (deletedIds.length > 0) {
      response += `✅ 已删除 ${deletedIds.length} 条\n\n`;
    }
    if (errors.length > 0) {
      response += `⚠️ 错误: ${errors.join(', ')}\n\n`;
    }
    response += formatScheduleList(remaining, schedulerConfig);
    // 2000字符限制处理
    if (response.length <= DISCORD_MAX_LENGTH) {
      await message.reply(response.replaceAll(SCHEDULE_SEPARATOR, ''));
    } else {
      const chunks = splitScheduleContent(response, DISCORD_SAFE_LENGTH);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    }
    return;
  }

  // !schedule toggle <id|编号>
  if (args.startsWith('toggle ')) {
    const idOrIndex = args.split(/\s+/)[1];
    if (!idOrIndex) {
      await message.reply('用法: `!schedule toggle <ID 或 编号>`');
      return;
    }

    let targetId = idOrIndex;
    const indexNum = parseInt(idOrIndex, 10);
    if (!isNaN(indexNum) && indexNum > 0 && !idOrIndex.startsWith('sch_')) {
      const schedules = scheduler.list(channelId);
      if (indexNum > schedules.length) {
        await message.reply(`❌ 编号 ${indexNum} 超出范围（1〜${schedules.length}）`);
        return;
      }
      targetId = schedules[indexNum - 1].id;
    }

    const schedule = scheduler.toggle(targetId);
    if (schedule) {
      const status = schedule.enabled ? '✅ 已启用' : '⏸️ 已禁用';
      const all = scheduler.list(channelId);
      const listContent = formatScheduleList(all, schedulerConfig).replaceAll(
        SCHEDULE_SEPARATOR,
        ''
      );
      await message.reply(`${status}: ${targetId}\n\n${listContent}`);
    } else {
      await message.reply(`❌ 未找到 ID \`${targetId}\``);
    }
    return;
  }

  // !schedule add <input> or !schedule <input> (无 add 也可以添加)
  const input = args.startsWith('add ') ? args.replace(/^add\s+/, '') : args;
  const parsed = parseScheduleInput(input);
  if (!parsed) {
    await message.reply(
      '❌ 无法解析输入\n\n' +
        '**支持格式:**\n' +
        '• `!schedule 30分钟后 消息`\n' +
        '• `!schedule 15:00 消息`\n' +
        '• `!schedule 每天 9:00 消息`\n' +
        '• `!schedule 每周一 10:00 消息`\n' +
        '• `!schedule cron 0 9 * * * 消息`\n' +
        '• `!schedule list` / `!schedule remove <ID>`'
    );
    return;
  }

  try {
    const targetChannel = parsed.targetChannelId || channelId;
    const schedule = scheduler.add({
      ...parsed,
      channelId: targetChannel,
      platform: 'discord' as Platform,
    });

    const channelInfo = parsed.targetChannelId ? ` → <#${parsed.targetChannelId}>` : '';
    const typeLabel = getTypeLabel(schedule.type, {
      expression: schedule.expression,
      runAt: schedule.runAt,
      channelInfo,
    });

    await message.reply(
      `✅ 已添加调度\n\n${typeLabel}\n📝 ${schedule.message}\n🆔 \`${schedule.id}\``
    );
  } catch (error) {
    await message.reply(`❌ ${error instanceof Error ? error.message : '发生错误'}`);
  }
}

/**
 * 执行 AI 响应中的 !schedule 命令
 */
async function executeScheduleFromResponse(
  text: string,
  sourceMessage: Message,
  scheduler: Scheduler,
  schedulerConfig?: { enabled: boolean; startupEnabled: boolean }
): Promise<void> {
  const args = text.replace(/^!schedule\s*/, '').trim();
  const channelId = sourceMessage.channel.id;
  const channel = sourceMessage.channel;

  // list 命令（显示全部）
  if (!args || args === 'list') {
    const schedules = scheduler.list();
    const content = formatScheduleList(schedules, schedulerConfig);
    if ('send' in channel) {
      const sendFn = (channel as { send: (content: string) => Promise<unknown> }).send.bind(
        channel
      );
      // 2000字符限制处理：分割发送
      if (content.length <= DISCORD_MAX_LENGTH) {
        await sendFn(content.replaceAll(SCHEDULE_SEPARATOR, ''));
      } else {
        const chunks = splitScheduleContent(content, DISCORD_SAFE_LENGTH);
        for (const chunk of chunks) {
          await sendFn(chunk);
        }
      }
    }
    return;
  }

  // remove 命令（支持多个）
  if (args.startsWith('remove ') || args.startsWith('delete ') || args.startsWith('rm ')) {
    const parts = args.split(/\s+/).slice(1).filter(Boolean);
    if (parts.length === 0) return;

    const schedules = scheduler.list();
    const deletedIds: string[] = [];

    // 按编号从大到小排序（防止删除时的偏移问题）
    const targets = parts
      .map((p) => {
        const num = parseInt(p, 10);
        if (!isNaN(num) && num > 0 && !p.startsWith('sch_')) {
          if (num > schedules.length) return null;
          return { index: num, id: schedules[num - 1].id };
        }
        return { index: 0, id: p };
      })
      .filter((t): t is { index: number; id: string } => t !== null)
      .sort((a, b) => b.index - a.index);

    for (const target of targets) {
      if (scheduler.remove(target.id)) {
        deletedIds.push(target.id);
      }
    }

    if ('send' in channel && deletedIds.length > 0) {
      const remaining = scheduler.list();
      const content = `✅ 已删除 ${deletedIds.length} 条\n\n${formatScheduleList(remaining, schedulerConfig)}`;
      const sendFn = (channel as { send: (content: string) => Promise<unknown> }).send.bind(
        channel
      );
      if (content.length <= DISCORD_MAX_LENGTH) {
        await sendFn(content.replaceAll(SCHEDULE_SEPARATOR, ''));
      } else {
        const chunks = splitScheduleContent(content, DISCORD_SAFE_LENGTH);
        for (const chunk of chunks) {
          await sendFn(chunk);
        }
      }
    }
    return;
  }

  // toggle 命令
  if (args.startsWith('toggle ')) {
    const idOrIndex = args.split(/\s+/)[1];
    if (!idOrIndex) return;

    let targetId = idOrIndex;
    const indexNum = parseInt(idOrIndex, 10);
    if (!isNaN(indexNum) && indexNum > 0 && !idOrIndex.startsWith('sch_')) {
      const schedules = scheduler.list(channelId);
      if (indexNum > schedules.length) {
        if ('send' in channel) {
          await (channel as { send: (content: string) => Promise<unknown> }).send(
            `❌ 编号 ${indexNum} 超出范围（1〜${schedules.length}）`
          );
        }
        return;
      }
      targetId = schedules[indexNum - 1].id;
    }

    const schedule = scheduler.toggle(targetId);
    if ('send' in channel) {
      if (schedule) {
        const status = schedule.enabled ? '✅ 已启用' : '⏸️ 已禁用';
        const all = scheduler.list(channelId);
        const listContent = formatScheduleList(all, schedulerConfig).replaceAll(
          SCHEDULE_SEPARATOR,
          ''
        );
        await (channel as { send: (content: string) => Promise<unknown> }).send(
          `${status}: ${targetId}\n\n${listContent}`
        );
      } else {
        await (channel as { send: (content: string) => Promise<unknown> }).send(
          `❌ 未找到 ID \`${targetId}\``
        );
      }
    }
    return;
  }

  const input = args.startsWith('add ') ? args.replace(/^add\s+/, '') : args;
  const parsed = parseScheduleInput(input);
  if (!parsed) {
    console.log(`[xangi] Failed to parse schedule input: ${input}`);
    return;
  }

  try {
    const targetChannel = parsed.targetChannelId || channelId;
    const schedule = scheduler.add({
      ...parsed,
      channelId: targetChannel,
      platform: 'discord' as Platform,
    });

    const channelInfo = parsed.targetChannelId ? ` → <#${parsed.targetChannelId}>` : '';
    const typeLabel = getTypeLabel(schedule.type, {
      expression: schedule.expression,
      runAt: schedule.runAt,
      channelInfo,
    });

    if ('send' in channel) {
      await (channel as { send: (content: string) => Promise<unknown> }).send(
        `✅ 已添加调度\n\n${typeLabel}\n📝 ${schedule.message}\n🆔 \`${schedule.id}\``
      );
    }
  } catch (error) {
    console.error('[xangi] Failed to add schedule from response:', error);
  }
}

main().catch(console.error);
