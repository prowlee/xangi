import {
  CHAT_SYSTEM_PROMPT_RESUME,
  CHAT_SYSTEM_PROMPT_PERSISTENT,
  XANGI_COMMANDS,
  buildXangiCommands,
  buildChatSystemResume,
  buildChatSystemPersistent,
} from './prompts/index.js';
import type { ChatPlatform } from './prompts/index.js';

/**
 * 运行器通用设置
 */
export interface BaseRunnerOptions {
  model?: string;
  timeoutMs?: number;
  workdir?: string;
  skipPermissions?: boolean;
}

// 重新导出提示词（为了不破坏现有的 import）
export { CHAT_SYSTEM_PROMPT_RESUME, CHAT_SYSTEM_PROMPT_PERSISTENT };

/**
 * 生成完整的系统提示词（用于 resume 型运行器）
 */
export function buildSystemPrompt(platform?: ChatPlatform): string {
  const systemPrompt = buildChatSystemResume(platform);
  const commands = buildXangiCommands(platform);
  return systemPrompt + '\n\n## XANGI_COMMANDS\n\n' + commands;
}

/**
 * 生成完整的系统提示词（用于常驻进程）
 */
export function buildPersistentSystemPrompt(platform?: ChatPlatform): string {
  const systemPrompt = buildChatSystemPersistent(platform);
  const commands = buildXangiCommands(platform);
  return systemPrompt + '\n\n## XANGI_COMMANDS\n\n' + commands;
}

// 重新导出 XANGI_COMMANDS（供 local-llm runner 等使用）
export { XANGI_COMMANDS };

// 从 safe-env.ts 重新导出（为了不破坏现有的 import）
export { getSafeEnv } from './safe-env.js';
