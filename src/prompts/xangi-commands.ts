/**
 * xangi 专用命令 — 按平台组合
 */
import { XANGI_COMMANDS_COMMON } from './xangi-commands-common.js';
import { XANGI_COMMANDS_CHAT_PLATFORM } from './xangi-commands-chat-platform.js';
import { XANGI_COMMANDS_DISCORD } from './xangi-commands-discord.js';
import { XANGI_COMMANDS_SLACK } from './xangi-commands-slack.js';
import { XANGI_COMMANDS_WEB } from './xangi-commands-web.js';

export type ChatPlatform = 'discord' | 'slack' | 'web';

/**
 * 根据平台构建 XANGI_COMMANDS
 * - discord: 通用 + 聊天平台通用 + Discord 专用
 * - slack: 通用 + 聊天平台通用 + Slack 专用
 * - web: 通用 + Web 专用
 * - undefined: 通用 + 聊天平台通用 + 所有平台
 */
export function buildXangiCommands(platform?: ChatPlatform): string {
  const parts = [XANGI_COMMANDS_COMMON];

  if (platform === 'web') {
    parts.push(XANGI_COMMANDS_WEB);
  } else {
    parts.push(XANGI_COMMANDS_CHAT_PLATFORM);

    if (platform === 'discord') {
      parts.push(XANGI_COMMANDS_DISCORD);
    } else if (platform === 'slack') {
      parts.push(XANGI_COMMANDS_SLACK);
    } else {
      parts.push(XANGI_COMMANDS_DISCORD);
      parts.push(XANGI_COMMANDS_SLACK);
    }
  }

  return parts.join('\n\n');
}

// 向后兼容
export const XANGI_COMMANDS = buildXangiCommands();

export {
  XANGI_COMMANDS_COMMON,
  XANGI_COMMANDS_CHAT_PLATFORM,
  XANGI_COMMANDS_DISCORD,
  XANGI_COMMANDS_SLACK,
  XANGI_COMMANDS_WEB,
};
