/**
 * 直接调用 Discord REST API 的模块
 *
 * 不依赖 xangi 进程的 Discord.js 客户端，
 * 直接通过 REST API 进行 Discord 操作。
 */

const API_BASE = 'https://discord.com/api/v10';
const MAX_MESSAGE_LENGTH = 2000;

function getToken(): string {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error('未设置 DISCORD_TOKEN 环境变量');
  }
  return token;
}

function getBotId(): string | undefined {
  return process.env.DISCORD_BOT_ID;
}

async function discordFetch(path: string, options?: RequestInit): Promise<unknown> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Discord API 错误 ${res.status}: ${body}`);
  }

  // 204 No Content
  if (res.status === 204) return null;
  return res.json();
}

// ─── Discord 消息类型 ───────────────────────────────────────────

interface DiscordMessage {
  id: string;
  content: string;
  author: { id: string; username: string; discriminator: string };
  timestamp: string;
  attachments: { id: string; filename: string; url: string }[];
}

interface DiscordChannel {
  id: string;
  name: string;
  type: number;
}

interface DiscordCommandContext {
  channelId?: string;
}

// ─── 命令 ───────────────────────────────────────────────────────

function resolveHistoryChannelId(
  flags: Record<string, string>,
  context?: DiscordCommandContext
): string {
  const explicitChannelId = flags['channel'];
  if (explicitChannelId) return explicitChannelId;

  const currentChannelId = context?.channelId ?? process.env.XANGI_CHANNEL_ID;
  if (currentChannelId) return currentChannelId;

  throw new Error(
    [
      'discord_history: 未指定 channel。',
      '如果在 xangi 中运行，会自动补全当前频道 ID。',
      '单独运行 CLI 时请添加 `--channel <频道ID>`。',
    ].join(' ')
  );
}

async function discordHistory(
  flags: Record<string, string>,
  context?: DiscordCommandContext
): Promise<string> {
  const channelId = resolveHistoryChannelId(flags, context);

  const count = Math.min(parseInt(flags['count'] || '10', 10), 100);
  const offset = parseInt(flags['offset'] || '0', 10);

  let beforeId: string | undefined;

  // 指定 offset 时：先获取 offset 条消息作为跳过
  if (offset > 0) {
    const skipMessages = (await discordFetch(
      `/channels/${channelId}/messages?limit=${offset}`
    )) as DiscordMessage[];
    if (skipMessages.length > 0) {
      beforeId = skipMessages[skipMessages.length - 1].id;
    }
  }

  const query = new URLSearchParams({ limit: String(count) });
  if (beforeId) query.set('before', beforeId);

  const messages = (await discordFetch(
    `/channels/${channelId}/messages?${query}`
  )) as DiscordMessage[];

  // 按时间正序排序
  messages.reverse();

  const rangeStart = offset;
  const rangeEnd = offset + messages.length;
  const offsetLabel = offset > 0 ? `第 ${rangeStart}～${rangeEnd} 条` : `最新 ${messages.length} 条`;

  const lines = messages.map((m) => {
    const time = new Date(m.timestamp).toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo',
    });
    const content = (m.content || '(仅附件)').slice(0, 200);
    const attachments =
      m.attachments.length > 0
        ? '\n' + m.attachments.map((a) => `  📎 ${a.filename} ${a.url}`).join('\n')
        : '';
    return `[${time}] (ID:${m.id}) ${m.author.username}: ${content}${attachments}`;
  });

  return `📺 频道历史记录（${offsetLabel}）:\n${lines.join('\n')}`;
}

async function discordSend(flags: Record<string, string>): Promise<string> {
  const channelId = flags['channel'];
  const message = flags['message'];
  if (!channelId) throw new Error('--channel 是必需的');
  if (!message) throw new Error('--message 是必需的');

  // 按 2000 字符限制分割发送
  const chunks: string[] = [];
  for (let i = 0; i < message.length; i += MAX_MESSAGE_LENGTH) {
    chunks.push(message.slice(i, i + MAX_MESSAGE_LENGTH));
  }

  for (const chunk of chunks) {
    await discordFetch(`/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: chunk,
        allowed_mentions: { parse: [] },
      }),
    });
  }

  return `✅ 消息已发送 (共 ${chunks.length} 段)`;
}

async function discordChannels(flags: Record<string, string>): Promise<string> {
  const guildId = flags['guild'];
  if (!guildId) throw new Error('--guild 是必需的');

  const channels = (await discordFetch(`/guilds/${guildId}/channels`)) as DiscordChannel[];

  // 仅文本频道 (type 0)
  const textChannels = channels
    .filter((c) => c.type === 0)
    .map((c) => `- #${c.name} (${c.id})`)
    .join('\n');

  return `📺 频道列表:\n${textChannels}`;
}

async function discordSearch(flags: Record<string, string>): Promise<string> {
  const channelId = flags['channel'];
  const keyword = flags['keyword'];
  if (!channelId) throw new Error('--channel 是必需的');
  if (!keyword) throw new Error('--keyword 是必需的');

  // Discord REST API 没有消息搜索功能，因此获取最新 100 条并过滤
  const messages = (await discordFetch(
    `/channels/${channelId}/messages?limit=100`
  )) as DiscordMessage[];

  const matched = messages.filter((m) => m.content.toLowerCase().includes(keyword.toLowerCase()));

  if (matched.length === 0) {
    return `🔍 未找到匹配「${keyword}」的消息`;
  }

  const results = matched
    .slice(0, 10)
    .map((m) => {
      const time = new Date(m.timestamp).toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
      });
      return `[${time}] ${m.author.username}: ${m.content.slice(0, 200)}`;
    })
    .join('\n');

  return `🔍 「${keyword}」的搜索结果 (共 ${matched.length} 条):\n${results}`;
}

async function discordEdit(flags: Record<string, string>): Promise<string> {
  const channelId = flags['channel'];
  const messageId = flags['message-id'];
  const content = flags['content'];
  if (!channelId) throw new Error('--channel 是必需的');
  if (!messageId) throw new Error('--message-id 是必需的');
  if (!content) throw new Error('--content 是必需的');

  // 确认是否为 bot 自己的消息
  const botId = getBotId();
  if (botId) {
    const msg = (await discordFetch(
      `/channels/${channelId}/messages/${messageId}`
    )) as DiscordMessage;
    if (msg.author.id !== botId) {
      return '❌ 只能编辑自己的消息';
    }
  }

  await discordFetch(`/channels/${channelId}/messages/${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ content }),
  });

  return '✏️ 消息已编辑';
}

async function discordDelete(flags: Record<string, string>): Promise<string> {
  const channelId = flags['channel'];
  const messageId = flags['message-id'];
  if (!channelId) throw new Error('--channel 是必需的');
  if (!messageId) throw new Error('--message-id 是必需的');

  // 确认是否为 bot 自己的消息
  const botId = getBotId();
  if (botId) {
    const msg = (await discordFetch(
      `/channels/${channelId}/messages/${messageId}`
    )) as DiscordMessage;
    if (msg.author.id !== botId) {
      return '❌ 只能删除自己的消息';
    }
  }

  await discordFetch(`/channels/${channelId}/messages/${messageId}`, {
    method: 'DELETE',
  });

  return '🗑️ 消息已删除';
}

async function mediaSend(flags: Record<string, string>): Promise<string> {
  const channelId = flags['channel'];
  const filePath = flags['file'];
  if (!channelId) throw new Error('--channel 是必需的');
  if (!filePath) throw new Error('--file 是必需的');

  const { readFileSync, existsSync } = await import('fs');
  const { basename } = await import('path');

  if (!existsSync(filePath)) {
    throw new Error(`文件未找到: ${filePath}`);
  }

  const fileName = basename(filePath);
  const fileData = readFileSync(filePath);
  const token = getToken();

  // 使用 multipart/form-data 发送
  const boundary = '----XangiFormBoundary' + Date.now();
  const parts: Buffer[] = [];

  // JSON payload 部分
  const jsonPayload = JSON.stringify({ content: '' });
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${jsonPayload}\r\n`
    )
  );

  // 文件部分
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    )
  );
  parts.push(fileData);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const res = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`上传文件失败: ${res.status} ${errBody}`);
  }

  return `📎 文件已发送: ${fileName}`;
}

// ─── 路由器 ─────────────────────────────────────────────────────────

export async function discordApi(
  command: string,
  flags: Record<string, string>,
  context?: DiscordCommandContext
): Promise<string> {
  switch (command) {
    case 'discord_history':
      return discordHistory(flags, context);
    case 'discord_send':
      return discordSend(flags);
    case 'discord_channels':
      return discordChannels(flags);
    case 'discord_search':
      return discordSearch(flags);
    case 'discord_edit':
      return discordEdit(flags);
    case 'discord_delete':
      return discordDelete(flags);
    case 'media_send':
      return mediaSend(flags);
    default:
      throw new Error(`未知的 discord 命令: ${command}`);
  }
}
