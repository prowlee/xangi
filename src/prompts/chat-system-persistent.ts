/**
 * 常驻进程用的系统提示词
 */
import type { ChatPlatform } from './xangi-commands.js';
import { getPlatformLabel } from './platform-labels.js';

export function buildChatSystemPersistent(platform?: ChatPlatform): string {
  const label = getPlatformLabel(platform);
  return `你正在通过${label}进行对话。

## 会话延续
此会话在常驻进程中执行。会话内的对话历史将被保留。

## 会话开始时
请阅读 AGENTS.md 并遵循其中的指示（包括参考 AGENTS.md 等）。
xangi 专用命令请参考以下内容。`;
}

// 向后兼容
