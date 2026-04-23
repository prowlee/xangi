import { App, LogLevel } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { Config } from './config.js';
import type { AgentRunner } from './agent-runner.js';
import { processManager } from './process-manager.js';
import type { Skill } from './skills.js';
import { formatSkillList } from './skills.js';
import {
  downloadFile,
  extractFilePaths,
  stripFilePaths,
  buildPromptWithAttachments,
} from './file-utils.js';
import { loadSettings, saveSettings, formatSettings } from './settings.js';
import { STREAM_UPDATE_INTERVAL_MS } from './constants.js';
import type { KnownBlock } from '@slack/types';

/** Slack Block Kit: Stop 按钮 */
function createSlackStopBlocks(): KnownBlock[] {
  return [
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Stop' },
          action_id: 'xangi_stop',
          style: 'danger',
        },
      ],
    },
  ];
}

/** Slack Block Kit: New Session 按钮 */
function createSlackCompletedBlocks(): KnownBlock[] {
  return [
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'New' },
          action_id: 'xangi_new',
        },
      ],
    },
  ];
}

// 会话管理（频道 ID → 会话 ID）
const sessions = new Map<string, string>();

// 最后一条 Bot 消息（频道 ID → 消息 ts）
const lastBotMessages = new Map<string, string>();

// Slack 消息字节数限制（chat.update 受字节数限制）
const SLACK_MAX_TEXT_BYTES = 3900;

/**
 * 按 UTF-8 字节数安全地截断字符串
 * 处理多字节字符，避免在中间切断
 */
function sliceByBytes(str: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(str).length <= maxBytes) {
    return str;
  }
  // 二分查找最大字符位置
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encoder.encode(str.slice(0, mid)).length <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return str.slice(0, lo);
}

// 发送结果（长文本时分段发送）
async function sendSlackResult(
  client: WebClient,
  channelId: string,
  messageTs: string,
  threadTs: string | undefined,
  result: string
): Promise<void> {
  const text = sliceByBytes(result, SLACK_MAX_TEXT_BYTES);
  const textBytes = new TextEncoder().encode(text).length;
  console.log(
    `[slack] sendSlackResult: 文本字符数=${text.length}, 文本字节数=${textBytes}, 结果字符数=${result.length}`
  );

  try {
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text,
    });

    // 如果有剩余文本，分段发送
    if (text.length < result.length) {
      const remaining = result.slice(text.length);
      const chunks = splitTextByBytes(remaining, SLACK_MAX_TEXT_BYTES);
      console.log(
        `[slack] 发送剩余 ${chunks.length} 个片段（剩余 ${remaining.length} 字符）`
      );
      for (const chunk of chunks) {
        await client.chat.postMessage({
          channel: channelId,
          text: chunk,
          ...(threadTs && { thread_ts: threadTs }),
        });
      }
    }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('[slack] 更新最终消息失败:', errorMessage);

    if (errorMessage.includes('msg_too_long')) {
      console.log(`[slack] 回退: 尝试更短的文本 (2000 字节)`);
      // 使用更短的文本重试
      try {
        await client.chat.update({
          channel: channelId,
          ts: messageTs,
          text: sliceByBytes(result, 2000),
        });
        console.log(`[slack] 回退: 短文本更新成功`);
      } catch {
        console.log(`[slack] 回退: 短文本更新失败，使用占位符`);
        // 仍然失败，则作为新消息发送
        await client.chat
          .update({
            channel: channelId,
            ts: messageTs,
            text: '（文本过长，已作为单独消息发送）',
          })
          .catch(() => {});
      }

      // 分段发送剩余内容
      const chunks = splitTextByBytes(result, SLACK_MAX_TEXT_BYTES);
      console.log(`[slack] 回退: 发送 ${chunks.length} 个片段`);
      for (const chunk of chunks) {
        await client.chat.postMessage({
          channel: channelId,
          text: chunk,
          ...(threadTs && { thread_ts: threadTs }),
        });
      }
      console.log(`[slack] 回退: 所有片段已发送`);
    } else {
      // 其他错误重新抛出
      throw err;
    }
  }
}

// 按字节数分割文本
function splitTextByBytes(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    const chunk = sliceByBytes(remaining, maxBytes);
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length);
  }
  return chunks;
}

// 删除消息的公共函数
/**
 * 检测 AI 响应中的 SYSTEM_COMMAND: 并执行
 */
function handleSystemCommands(text: string): void {
  const commands = text.match(/^SYSTEM_COMMAND:(.+)$/gm);
  if (!commands) return;

  for (const cmd of commands) {
    const action = cmd.replace('SYSTEM_COMMAND:', '').trim();

    if (action === 'restart') {
      const settings = loadSettings();
      if (!settings.autoRestart) {
        console.log('[slack] 请求重启但 autoRestart 已禁用');
        continue;
      }
      console.log('[slack] Agent 请求重启，1秒后重启...');
      setTimeout(() => process.exit(0), 1000);
      return;
    }

    const setMatch = action.match(/^set\s+(\w+)=(.*)/);
    if (setMatch) {
      const [, key, value] = setMatch;
      if (key === 'autoRestart') {
        const enabled = value === 'true';
        saveSettings({ autoRestart: enabled });
        console.log(`[slack] Agent 已将 autoRestart 设为 ${enabled ? '启用' : '禁用'}`);
      }
    }
  }
}

async function deleteMessage(client: WebClient, channelId: string, arg: string): Promise<string> {
  let messageTs: string | undefined;

  if (arg) {
    // 有参数时：从 ts 或消息链接中提取
    const linkMatch = arg.match(/\/p(\d{10})(\d{6})/);
    if (linkMatch) {
      messageTs = `${linkMatch[1]}.${linkMatch[2]}`;
    } else if (/^\d+\.\d+$/.test(arg)) {
      messageTs = arg;
    } else {
      return '格式无效。请指定消息链接或 ts';
    }
  } else {
    messageTs = lastBotMessages.get(channelId);
    if (!messageTs) {
      return '没有可删除的消息';
    }
  }

  try {
    await client.chat.delete({
      channel: channelId,
      ts: messageTs,
    });
    if (!arg) {
      lastBotMessages.delete(channelId);
    }
    return '🗑️ 消息已删除';
  } catch (err) {
    console.error('[slack] 删除消息失败:', err);
    return '删除消息失败';
  }
}

import type { Scheduler } from './scheduler.js';

export interface SlackChannelOptions {
  config: Config;
  agentRunner: AgentRunner;
  skills: Skill[];
  reloadSkills: () => Skill[];
  scheduler?: Scheduler;
}

export async function startSlackBot(options: SlackChannelOptions): Promise<void> {
  const { config, agentRunner, reloadSkills } = options;
  let { skills } = options;

  if (!config.slack.botToken || !config.slack.appToken) {
    throw new Error('Slack 令牌未配置');
  }

  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  // 按钮操作: Stop
  app.action('xangi_stop', async ({ ack, body }) => {
    await ack();
    const channelId = body.channel?.id;
    if (!channelId) return;
    const userId = body.user?.id;
    if (
      !config.slack.allowedUsers?.includes('*') &&
      userId &&
      !config.slack.allowedUsers?.includes(userId)
    ) {
      return;
    }
    const stopped = processManager.stop(channelId) || agentRunner.cancel?.(channelId) || false;
    if (!stopped) {
      console.log(`[slack] 频道 ${channelId} 没有正在运行的任务需要停止`);
    }
  });

  // 按钮操作: New Session
  app.action('xangi_new', async ({ ack, body, client: actionClient }) => {
    await ack();
    const channelId = body.channel?.id;
    if (!channelId) return;
    const userId = body.user?.id;
    if (
      !config.slack.allowedUsers?.includes('*') &&
      userId &&
      !config.slack.allowedUsers?.includes(userId)
    ) {
      return;
    }
    sessions.delete(channelId);
    agentRunner.destroy?.(channelId);
    // 移除按钮
    if ('message' in body && body.message) {
      await actionClient.chat
        .update({
          channel: channelId,
          ts: (body.message as { ts: string }).ts,
          text: (body.message as { text?: string }).text || '✅',
          blocks: [],
        })
        .catch(() => {});
    }
  });

  // 处理 @提及 事件
  app.event('app_mention', async ({ event, say, client }) => {
    const userId = event.user;
    if (!userId) return;

    // 权限列表检查
    if (!config.slack.allowedUsers?.includes('*') && !config.slack.allowedUsers?.includes(userId)) {
      console.log(`[slack] 未授权用户: ${userId}`);
      return;
    }

    let text = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();

    // 下载附件
    const attachmentPaths: string[] = [];
    const files = (event as unknown as Record<string, unknown>).files as
      | Array<{ url_private_download?: string; name?: string }>
      | undefined;
    if (files && files.length > 0) {
      for (const file of files) {
        if (file.url_private_download) {
          try {
            const filePath = await downloadFile(file.url_private_download, file.name || 'file', {
              Authorization: `Bearer ${config.slack.botToken}`,
            });
            attachmentPaths.push(filePath);
          } catch (err) {
            console.error(`[slack] 下载附件失败: ${file.name}`, err);
          }
        }
      }
    }

    if (!text && attachmentPaths.length === 0) return;
    text = buildPromptWithAttachments(text || '请检查附件', attachmentPaths);

    const channelId = event.channel;
    const threadTs = config.slack.replyInThread ? event.thread_ts || event.ts : undefined;

    // 会话清除命令
    if (['!new', 'new', '/new', '!clear', 'clear', '/clear'].includes(text)) {
      sessions.delete(channelId);
      await say({
        text: '🆕 已开始新会话',
        ...(threadTs && { thread_ts: threadTs }),
      });
      return;
    }

    // 停止命令
    if (['!stop', 'stop', '/stop'].includes(text)) {
      const stopped = processManager.stop(channelId) || agentRunner.cancel?.(channelId) || false;
      await say({
        text: stopped ? '🛑 任务已停止' : '没有正在运行的任务',
        ...(threadTs && { thread_ts: threadTs }),
      });
      return;
    }

    // 删除命令
    if (text === '!delete' || text === 'delete' || text.startsWith('!delete ')) {
      const arg = text.replace(/^!?delete\s*/, '').trim();
      const result = await deleteMessage(client, channelId, arg);
      await say({
        text: result,
        ...(threadTs && { thread_ts: threadTs }),
      });
      return;
    }

    // 👀 添加反应
    await client.reactions
      .add({
        channel: channelId,
        timestamp: event.ts,
        name: 'eyes',
      })
      .catch((err) => {
        console.error('[slack] 添加反应失败:', err.message || err);
      });

    await processMessage(channelId, threadTs, text, event.ts, client, agentRunner, config);
  });

  // 处理 DM 和 autoReplyChannels 中的消息
  app.event('message', async ({ event, say, client }) => {
    // 忽略 bot 消息
    if ('bot_id' in event || !('user' in event)) return;

    const messageEvent = event as {
      user: string;
      text?: string;
      channel: string;
      ts: string;
      thread_ts?: string;
      channel_type?: string;
      files?: Array<{ url_private_download?: string; name?: string }>;
    };

    console.log(
      `[slack] 消息事件: 频道=${messageEvent.channel}, 类型=${messageEvent.channel_type}, autoReplyChannels=${config.slack.autoReplyChannels?.join(',')}`
    );

    // 处理 DM、autoReplyChannels 或线程内回复
    const isDM = messageEvent.channel_type === 'im';
    const isAutoReplyChannel = config.slack.autoReplyChannels?.includes(messageEvent.channel);
    const isThreadReply = !!messageEvent.thread_ts;
    if (!isDM && !isAutoReplyChannel && !isThreadReply) {
      console.log(
        `[slack] 跳过: isDM=${isDM}, isAutoReplyChannel=${isAutoReplyChannel}, 是线程=${isThreadReply}`
      );
      return;
    }

    // autoReplyChannels 中带 @提及 的消息已由 app_mention 处理，跳过
    const textRaw = messageEvent.text || '';
    if (isAutoReplyChannel && !isThreadReply && /<@[A-Z0-9]+>/i.test(textRaw)) {
      console.log(`[slack] 跳过 autoReplyChannel 中的提及消息（由 app_mention 处理）`);
      return;
    }

    // 权限列表检查
    if (
      !config.slack.allowedUsers?.includes('*') &&
      !config.slack.allowedUsers?.includes(messageEvent.user)
    ) {
      console.log(`[slack] 未授权用户: ${messageEvent.user}`);
      return;
    }

    let text = messageEvent.text || '';

    // 下载附件
    const dmAttachmentPaths: string[] = [];
    if (messageEvent.files && messageEvent.files.length > 0) {
      for (const file of messageEvent.files) {
        if (file.url_private_download) {
          try {
            const filePath = await downloadFile(file.url_private_download, file.name || 'file', {
              Authorization: `Bearer ${config.slack.botToken}`,
            });
            dmAttachmentPaths.push(filePath);
          } catch (err) {
            console.error(`[slack] 下载附件失败: ${file.name}`, err);
          }
        }
      }
    }

    if (!text && dmAttachmentPaths.length === 0) return;
    text = buildPromptWithAttachments(text || '请检查附件', dmAttachmentPaths);

    const channelId = messageEvent.channel;
    const threadTs = config.slack.replyInThread ? messageEvent.ts : undefined;

    // 会话清除命令
    if (['!new', 'new', '/new', '!clear', 'clear', '/clear'].includes(text)) {
      sessions.delete(channelId);
      await say({
        text: '🆕 已开始新会话',
        ...(threadTs && { thread_ts: threadTs }),
      });
      return;
    }

    // 停止命令
    if (['!stop', 'stop', '/stop'].includes(text)) {
      const stopped = processManager.stop(channelId) || agentRunner.cancel?.(channelId) || false;
      await say({
        text: stopped ? '🛑 任务已停止' : '没有正在运行的任务',
        ...(threadTs && { thread_ts: threadTs }),
      });
      return;
    }

    // 删除命令
    if (text === '!delete' || text === 'delete' || text.startsWith('!delete ')) {
      const arg = text.replace(/^!?delete\s*/, '').trim();
      const result = await deleteMessage(client, channelId, arg);
      await say({
        text: result,
        ...(threadTs && { thread_ts: threadTs }),
      });
      return;
    }

    // 👀 添加反应
    await client.reactions
      .add({
        channel: channelId,
        timestamp: messageEvent.ts,
        name: 'eyes',
      })
      .catch((err) => {
        console.error('[slack] 添加反应失败:', err.message || err);
      });

    await processMessage(channelId, threadTs, text, messageEvent.ts, client, agentRunner, config);
  });

  // /new 命令
  app.command('/new', async ({ command, ack, respond }) => {
    await ack();

    if (
      !config.slack.allowedUsers?.includes('*') &&
      !config.slack.allowedUsers?.includes(command.user_id)
    ) {
      await respond({ text: '未授权的用户', response_type: 'ephemeral' });
      return;
    }

    sessions.delete(command.channel_id);
    await respond({ text: '🆕 已开始新会话' });
  });

  // /skills 命令
  app.command('/skills', async ({ command, ack, respond }) => {
    await ack();

    if (
      !config.slack.allowedUsers?.includes('*') &&
      !config.slack.allowedUsers?.includes(command.user_id)
    ) {
      await respond({ text: '未授权的用户', response_type: 'ephemeral' });
      return;
    }

    skills = reloadSkills();
    await respond({ text: formatSkillList(skills) });
  });

  // /delete 命令（删除 Bot 消息）
  // /delete → 删除上一条消息
  // /delete <ts> → 删除指定消息（从 ts 或消息链接中提取）
  app.command('/delete', async ({ command, ack, respond, client }) => {
    await ack();

    if (
      !config.slack.allowedUsers?.includes('*') &&
      !config.slack.allowedUsers?.includes(command.user_id)
    ) {
      await respond({ text: '未授权的用户', response_type: 'ephemeral' });
      return;
    }

    const result = await deleteMessage(client, command.channel_id, command.text.trim());
    await respond({ text: result, response_type: 'ephemeral' });
  });

  // /skill 命令
  app.command('/skill', async ({ command, ack, respond }) => {
    await ack();

    if (
      !config.slack.allowedUsers?.includes('*') &&
      !config.slack.allowedUsers?.includes(command.user_id)
    ) {
      await respond({ text: '未授权的用户', response_type: 'ephemeral' });
      return;
    }

    const args = command.text.trim().split(/\s+/);
    const skillName = args[0];
    const skillArgs = args.slice(1).join(' ');

    if (!skillName) {
      await respond({ text: '使用方法: `/skill <技能名> [参数]`' });
      return;
    }

    const channelId = command.channel_id;
    const skipPermissions = config.agent.config.skipPermissions ?? false;

    try {
      const prompt = `请执行技能「${skillName}」。${skillArgs ? `参数: ${skillArgs}` : ''}`;
      const sessionId = sessions.get(channelId);
      const { result, sessionId: newSessionId } = await agentRunner.run(prompt, {
        skipPermissions,
        sessionId,
        channelId,
      });

      sessions.set(channelId, newSessionId);
      await respond({ text: sliceByBytes(result, SLACK_MAX_TEXT_BYTES) });
    } catch (error) {
      console.error('[slack] 错误:', error);
      await respond({ text: '发生错误' });
    }
  });

  // /settings 命令
  app.command('/settings', async ({ command, ack, respond }) => {
    await ack();

    if (
      !config.slack.allowedUsers?.includes('*') &&
      !config.slack.allowedUsers?.includes(command.user_id)
    ) {
      await respond({ text: '未授权的用户', response_type: 'ephemeral' });
      return;
    }

    const settings = loadSettings();
    await respond({ text: formatSettings(settings) });
  });

  // /restart 命令
  app.command('/restart', async ({ command, ack, respond }) => {
    await ack();

    if (
      !config.slack.allowedUsers?.includes('*') &&
      !config.slack.allowedUsers?.includes(command.user_id)
    ) {
      await respond({ text: '未授权的用户', response_type: 'ephemeral' });
      return;
    }

    const settings = loadSettings();
    if (!settings.autoRestart) {
      await respond({ text: '⚠️ 自动重启已禁用。请先启用。' });
      return;
    }
    await respond({ text: '🔄 正在重启...' });
    setTimeout(() => process.exit(0), 1000);
  });

  await app.start();
  console.log('[slack] ⚡️ Slack bot 正在运行！');

  // 向调度器注册 Slack 发送函数
  if (options.scheduler) {
    options.scheduler.registerSender('slack', async (channelId, msg) => {
      await app.client.chat.postMessage({
        channel: channelId,
        text: msg,
      });
    });
  }
}

async function processMessage(
  channelId: string,
  threadTs: string | undefined,
  text: string,
  originalTs: string,
  client: WebClient,
  agentRunner: AgentRunner,
  config: Config
): Promise<void> {
  const skipPermissions = config.agent.config.skipPermissions ?? false;
  let prompt = text;

  // 跳过权限设置
  if (prompt.startsWith('!skip')) {
    prompt = prompt.replace(/^!skip\s*/, '').trim();
  }

  // 将平台信息注入提示词
  prompt = `[平台: Slack]\n[频道: ${channelId}]\n${prompt}`;

  let messageTs = '';
  try {
    console.log(`[slack] 正在处理频道 ${channelId} 中的消息`);

    const sessionId = sessions.get(channelId);
    const useStreaming = config.slack.streaming ?? true;
    const showThinking = config.slack.showThinking ?? true;

    // 发送初始消息（带 Stop 按钮）
    const showButtons = config.slack.showThinking ?? true;
    const initialResponse = await client.chat.postMessage({
      channel: channelId,
      text: '🤔 思考中.',
      ...(threadTs && { thread_ts: threadTs }),
      ...(showButtons && {
        blocks: [
          { type: 'section' as const, text: { type: 'mrkdwn' as const, text: '🤔 思考中.' } },
          ...createSlackStopBlocks(),
        ],
      }),
    });

    messageTs = initialResponse.ts ?? '';
    if (!messageTs) {
      throw new Error('无法获取消息时间戳');
    }

    // 保存最后一条 Bot 消息
    lastBotMessages.set(channelId, messageTs);

    let result: string;
    let newSessionId: string;

    if (useStreaming && showThinking) {
      // 流式 + 思考显示模式
      let lastUpdateTime = 0;
      let pendingUpdate = false;
      let firstTextReceived = false;

      // 文本到达前的思考动画
      let dotCount = 1;
      const thinkingInterval = setInterval(() => {
        if (firstTextReceived) return;
        dotCount = (dotCount % 3) + 1;
        const dots = '.'.repeat(dotCount);
        const thinkingText = `🤔 思考中${dots}`;
        client.chat
          .update({
            channel: channelId,
            ts: messageTs,
            text: thinkingText,
            ...(showButtons && {
              blocks: [
                { type: 'section' as const, text: { type: 'mrkdwn' as const, text: thinkingText } },
                ...createSlackStopBlocks(),
              ],
            }),
          })
          .catch(() => {});
      }, 1000);

      let streamResult: { result: string; sessionId: string };
      try {
        streamResult = await agentRunner.runStream(
          prompt,
          {
            onText: (_chunk, fullText) => {
              if (!firstTextReceived) {
                firstTextReceived = true;
                clearInterval(thinkingInterval);
              }
              const now = Date.now();
              if (now - lastUpdateTime >= STREAM_UPDATE_INTERVAL_MS && !pendingUpdate) {
                pendingUpdate = true;
                lastUpdateTime = now;
                const streamText = sliceByBytes(fullText, SLACK_MAX_TEXT_BYTES - 10) + ' ▌';
                const streamBytes = new TextEncoder().encode(streamText).length;
                console.log(
                  `[slack] 流式更新: 字符数=${streamText.length}, 字节数=${streamBytes}`
                );
                client.chat
                  .update({
                    channel: channelId,
                    ts: messageTs,
                    text: streamText,
                  })
                  .catch((err) => {
                    console.error(
                      `[slack] 更新消息失败 (字节数=${streamBytes}):`,
                      err.message
                    );
                  })
                  .finally(() => {
                    pendingUpdate = false;
                  });
              }
            },
          },
          { skipPermissions, sessionId, channelId }
        );
      } finally {
        clearInterval(thinkingInterval);
      }
      result = streamResult.result;
      newSessionId = streamResult.sessionId;
    } else {
      // 非流式或思考隐藏模式
      // 思考动画
      let dotCount = 1;
      const thinkingInterval = setInterval(() => {
        dotCount = (dotCount % 3) + 1;
        const dots = '.'.repeat(dotCount);
        const thinkingText = `🤔 思考中${dots}`;
        client.chat
          .update({
            channel: channelId,
            ts: messageTs,
            text: thinkingText,
            ...(showButtons && {
              blocks: [
                { type: 'section' as const, text: { type: 'mrkdwn' as const, text: thinkingText } },
                ...createSlackStopBlocks(),
              ],
            }),
          })
          .catch(() => {});
      }, 1000);

      try {
        const runResult = await agentRunner.run(prompt, { skipPermissions, sessionId, channelId });
        result = runResult.result;
        newSessionId = runResult.sessionId;
      } finally {
        clearInterval(thinkingInterval);
      }
    }

    sessions.set(channelId, newSessionId);
    console.log(`[slack] 最终结果长度: ${result.length}`);

    // 提取文件路径并发送附件
    const filePaths = extractFilePaths(result);
    let displayText = filePaths.length > 0 ? stripFilePaths(result) : result;

    // 从显示文本中移除 SYSTEM_COMMAND: 行
    displayText = displayText.replace(/^SYSTEM_COMMAND:.+$/gm, '').trim();

    // 检测并执行 SYSTEM_COMMAND:
    handleSystemCommands(result);

    // 更新最终结果（长文本时分段发送）
    await sendSlackResult(client, channelId, messageTs, threadTs, displayText || '✅');

    // 完成后：将 Stop 按钮替换为 New 按钮
    if (showButtons) {
      await client.chat
        .update({
          channel: channelId,
          ts: messageTs,
          text: sliceByBytes(displayText || '✅', SLACK_MAX_TEXT_BYTES),
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: sliceByBytes(displayText || '✅', 3000) },
            },
            ...createSlackCompletedBlocks(),
          ],
        })
        .catch(() => {});
    }

    if (filePaths.length > 0) {
      try {
        for (const fp of filePaths) {
          const fileContent = await import('fs').then((fs) => fs.default.readFileSync(fp));
          const filename = await import('path').then((path) => path.default.basename(fp));
          const uploadArgs: Record<string, unknown> = {
            channel_id: channelId,
            file: fileContent,
            filename,
          };
          if (threadTs) {
            uploadArgs.thread_ts = threadTs;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await client.filesUploadV2(uploadArgs as any);
        }
        console.log(`[slack] 已发送 ${filePaths.length} 个文件`);
      } catch (err) {
        console.error('[slack] 上传文件失败:', err);
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('Request cancelled by user')) {
      console.log('[slack] 用户取消了请求');
      if (messageTs) {
        await client.chat
          .update({
            channel: channelId,
            ts: messageTs,
            text: '🛑 已停止',
            blocks: [],
          })
          .catch(() => {});
      }
    } else {
      console.error('[slack] 错误:', error);
      await client.chat.postMessage({
        channel: channelId,
        text: `发生错误: ${errorMsg.slice(0, 200)}`,
        ...(threadTs && { thread_ts: threadTs }),
      });
    }
  } finally {
    // 👀 移除反应
    await client.reactions
      .remove({
        channel: channelId,
        timestamp: originalTs,
        name: 'eyes',
      })
      .catch((err) => {
        console.error('[slack] 移除反应失败:', err.message || err);
      });
  }
}
