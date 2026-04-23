import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * 将会话单位的转录（对话日志）保存为 JSONL 文件
 *
 * 每个会话一个日志文件：
 *   logs/sessions/<appSessionId>.jsonl
 */

export interface TranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string | Record<string, unknown>;
  createdAt: string;
  usage?: Record<string, unknown>;
}

function getSessionLogPath(workdir: string, appSessionId: string): string {
  const dir = join(workdir, 'logs', 'sessions');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, `${appSessionId}.jsonl`);
}

function generateMessageId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function writeEntry(workdir: string, appSessionId: string, entry: TranscriptEntry): void {
  try {
    const filePath = getSessionLogPath(workdir, appSessionId);
    const line = JSON.stringify(entry);
    appendFileSync(filePath, line + '\n');
  } catch (err) {
    console.warn('[transcript] 写入日志失败:', err);
  }
}

/**
 * 记录用户的提示词
 */
export function logPrompt(workdir: string, appSessionId: string, prompt: string): void {
  writeEntry(workdir, appSessionId, {
    id: generateMessageId(),
    role: 'user',
    content: prompt,
    createdAt: new Date().toISOString(),
  });
}

/**
 * 记录 AI 的响应
 */
export function logResponse(
  workdir: string,
  appSessionId: string,
  json: Record<string, unknown>
): void {
  writeEntry(workdir, appSessionId, {
    id: generateMessageId(),
    role: 'assistant',
    content: json,
    createdAt: new Date().toISOString(),
  });
}

/**
 * 记录错误
 */
export function logError(workdir: string, appSessionId: string, error: string): void {
  writeEntry(workdir, appSessionId, {
    id: generateMessageId(),
    role: 'error',
    content: error,
    createdAt: new Date().toISOString(),
  });
}

/**
 * 读取会话的消息列表
 */
export function readSessionMessages(workdir: string, appSessionId: string): TranscriptEntry[] {
  try {
    const filePath = getSessionLogPath(workdir, appSessionId);
    if (!existsSync(filePath)) return [];
    const content = readFileSync(filePath, 'utf-8');
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as TranscriptEntry);
  } catch {
    return [];
  }
}
