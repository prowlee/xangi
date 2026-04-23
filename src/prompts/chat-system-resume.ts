/**
 * 会话恢复时（--resume）的系统提示词
 */
import type { ChatPlatform } from './xangi-commands.js';
import { getPlatformLabel } from './platform-labels.js';

export function buildChatSystemResume(platform?: ChatPlatform): string {
  const label = getPlatformLabel(platform);
  return `你正在通过${label}进行对话。

## 会话延续
此会话通过 --resume 选项继续。过去的对话历史已被保留，因此你记得之前的对话内容。请不要说“因为重启了所以不记得”。

## 会话开始时
请阅读 AGENTS.md 并遵循其中的指示（包括参考 AGENTS.md 等）。
xangi 专用命令请参考以下内容。`;
}

// 向后兼容
export const CHAT_SYSTEM_PROMPT_RESUME = buildChatSystemResume();
