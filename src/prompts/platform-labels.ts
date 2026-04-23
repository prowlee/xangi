import type { ChatPlatform } from './xangi-commands.js';

const LABELS: Record<string, string> = {
  discord: '聊天平台（Discord）',
  slack: '聊天平台（Slack）',
  web: 'Web 浏览器',
};

export function getPlatformLabel(platform?: ChatPlatform): string {
  return platform
    ? LABELS[platform] || '聊天平台'
    : '聊天平台（Discord/Slack）';
}
