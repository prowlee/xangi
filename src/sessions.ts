import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';

/**
 * 会话管理（appSessionId 方式）
 *
 * - appSessionId: xangi 自身的会话 ID。/new 时或聊天开始时由 xangi 立即确定
 * - providerSessionId: Claude Code 等后端返回的 sessionId。响应后附加保存
 *
 * sessions.json 的结构:
 * {
 *   "activeByContext": { "<contextKey>": "<appSessionId>" },
 *   "sessions": { "<appSessionId>": SessionEntry }
 * }
 *
 * 日志文件: logs/sessions/<appSessionId>.jsonl
 */

export type SessionScope = 'interactive' | 'scheduler';

export interface AgentInfo {
  backend: string; // 'claude-code' | 'codex' | 'gemini' | 'local-llm'
  providerSessionId?: string;
}

export interface SessionEntry {
  id: string; // appSessionId
  title: string;
  platform: string; // 'discord' | 'slack' | 'web'
  contextKey: string; // channelId or 'web-chat'
  scope: SessionScope;
  bootId: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  agent?: AgentInfo;
  archived: boolean;
}

interface SessionsFile {
  activeByContext: Record<string, string>;
  sessions: Record<string, SessionEntry>;
}

let sessionsPath: string | null = null;
let data: SessionsFile = { activeByContext: {}, sessions: {} };
let currentBootId: string = randomUUID();

/**
 * 初始化 sessions.json 的路径
 */
export function initSessions(dataDir: string): void {
  sessionsPath = join(dataDir, 'sessions.json');
  currentBootId = randomUUID();
  loadSessionsFromFile();
  purgeSchedulerSessions();
}

export function getBootId(): string {
  return currentBootId;
}

export function getSessionsPath(): string {
  if (!sessionsPath) {
    throw new Error('会话未初始化。请先调用 initSessions(dataDir)。');
  }
  return sessionsPath;
}

/**
 * 从文件读取会话（向后兼容旧格式）
 */
function loadSessionsFromFile(): void {
  const path = getSessionsPath();
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw);

      // 检测新格式
      if (parsed.activeByContext && parsed.sessions) {
        data = parsed as SessionsFile;
      } else {
        // 旧格式: { channelId: SessionEntry | string } → 迁移
        data = { activeByContext: {}, sessions: {} };
        for (const [key, value] of Object.entries(parsed)) {
          const entry =
            typeof value === 'string'
              ? {
                  sessionId: value,
                  scope: 'interactive' as const,
                  bootId: '',
                  updatedAt: new Date().toISOString(),
                }
              : (value as {
                  sessionId: string;
                  scope?: string;
                  bootId?: string;
                  updatedAt?: string;
                  title?: string;
                  platform?: string;
                  createdAt?: string;
                });

          const appId = generateAppSessionId();
          data.sessions[appId] = {
            id: appId,
            title: (entry as { title?: string }).title || '',
            platform: (entry as { platform?: string }).platform || 'discord',
            contextKey: key,
            scope: (entry.scope as SessionScope) || 'interactive',
            bootId: entry.bootId || '',
            createdAt:
              (entry as { createdAt?: string }).createdAt ||
              entry.updatedAt ||
              new Date().toISOString(),
            updatedAt: entry.updatedAt || new Date().toISOString(),
            messageCount: 0,
            agent: entry.sessionId
              ? { backend: 'claude-code', providerSessionId: entry.sessionId }
              : undefined,
            archived: false,
          };
          data.activeByContext[key] = appId;
        }
        console.log(`[xangi] 已将 ${Object.keys(data.sessions).length} 个会话迁移到新格式`);
      }
      console.log(`[xangi] 从 ${path} 加载了 ${Object.keys(data.sessions).length} 个会话`);
    }
  } catch (err) {
    console.error('[xangi] 加载会话失败:', err);
    data = { activeByContext: {}, sessions: {} };
  }
}

function saveSessionsToFile(): void {
  const path = getSessionsPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  } catch (err) {
    console.error('[xangi] 保存会话失败:', err);
  }
}

function purgeSchedulerSessions(): void {
  let purged = 0;
  for (const [id, entry] of Object.entries(data.sessions)) {
    if (entry.scope === 'scheduler') {
      delete data.sessions[id];
      // 同时从 activeByContext 中删除
      for (const [ctx, activeId] of Object.entries(data.activeByContext)) {
        if (activeId === id) {
          delete data.activeByContext[ctx];
        }
      }
      purged++;
    }
  }
  if (purged > 0) {
    console.log(`[xangi] 已清理 ${purged} 个过期的调度器会话`);
    saveSessionsToFile();
  }
}

/**
 * 生成 appSessionId（ULID 风格的可按时间排序的 ID）
 */
function generateAppSessionId(): string {
  const ts = Date.now().toString(36).padStart(9, '0');
  const rand = randomUUID().replace(/-/g, '').slice(0, 8);
  return `${ts}_${rand}`;
}

// ─── 公共 API ───

/**
 * 从 contextKey（channelId 等）获取活跃的 appSessionId
 */
export function getActiveSessionId(contextKey: string): string | undefined {
  return data.activeByContext[contextKey];
}

/**
 * 从 appSessionId 获取会话信息
 */
export function getSessionEntry(appSessionId: string): SessionEntry | undefined {
  return data.sessions[appSessionId];
}

/**
 * 从 contextKey 获取活跃会话的 providerSessionId（用于 --resume）
 */
export function getProviderSessionId(contextKey: string): string | undefined {
  const appId = data.activeByContext[contextKey];
  if (!appId) return undefined;
  return data.sessions[appId]?.agent?.providerSessionId;
}

/**
 * 向后兼容: getSession(channelId) → providerSessionId
 */
export function getSession(channelId: string): string | undefined {
  return getProviderSessionId(channelId);
}

/**
 * 创建新会话并设为活跃
 */
export function createSession(
  contextKey: string,
  opts: {
    platform?: string;
    scope?: SessionScope;
    title?: string;
    backend?: string;
  } = {}
): string {
  const appId = generateAppSessionId();
  const now = new Date().toISOString();

  data.sessions[appId] = {
    id: appId,
    title: opts.title || '',
    platform: opts.platform || 'discord',
    contextKey,
    scope: opts.scope || 'interactive',
    bootId: currentBootId,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    agent: opts.backend ? { backend: opts.backend } : undefined,
    archived: false,
  };
  data.activeByContext[contextKey] = appId;
  saveSessionsToFile();
  return appId;
}

/**
 * 为会话附加保存 providerSessionId
 */
export function setProviderSessionId(
  appSessionId: string,
  providerSessionId: string,
  backend?: string
): void {
  const entry = data.sessions[appSessionId];
  if (!entry) return;
  entry.agent = {
    backend: backend || entry.agent?.backend || 'claude-code',
    providerSessionId,
  };
  entry.updatedAt = new Date().toISOString();
  saveSessionsToFile();
}

/**
 * 向后兼容: setSession(channelId, providerSessionId, scope)
 * 如果没有活跃会话则创建新会话，否则更新
 */
export function setSession(
  channelId: string,
  providerSessionId: string,
  scope: SessionScope = 'interactive'
): void {
  let appId = data.activeByContext[channelId];
  if (!appId || !data.sessions[appId]) {
    appId = createSession(channelId, { scope });
  }
  setProviderSessionId(appId, providerSessionId);
}

/**
 * 更新会话标题
 */
export function updateSessionTitle(appSessionId: string, title: string): void {
  const entry = data.sessions[appSessionId];
  if (!entry) return;
  entry.title = title;
  entry.updatedAt = new Date().toISOString();
  saveSessionsToFile();
}

/**
 * 增加会话的消息计数
 */
export function incrementMessageCount(appSessionId: string): void {
  const entry = data.sessions[appSessionId];
  if (!entry) return;
  entry.messageCount++;
  entry.updatedAt = new Date().toISOString();
  saveSessionsToFile();
}

/**
 * 将会话归档
 */
export function archiveSession(appSessionId: string): void {
  const entry = data.sessions[appSessionId];
  if (!entry) return;
  entry.archived = true;
  // 从 activeByContext 中移除
  for (const [ctx, id] of Object.entries(data.activeByContext)) {
    if (id === appSessionId) {
      delete data.activeByContext[ctx];
    }
  }
  saveSessionsToFile();
}

/**
 * 将已有会话设为指定 contextKey 的活跃会话（用于 resume）
 */
export function activateSession(contextKey: string, appSessionId: string): void {
  data.activeByContext[contextKey] = appSessionId;
  const entry = data.sessions[appSessionId];
  if (entry) {
    entry.archived = false;
    entry.updatedAt = new Date().toISOString();
  }
  saveSessionsToFile();
}

/**
 * 完全删除会话（从 sessions.json 中移除）
 */
export function removeSession(appSessionId: string): void {
  delete data.sessions[appSessionId];
  for (const [ctx, id] of Object.entries(data.activeByContext)) {
    if (id === appSessionId) {
      delete data.activeByContext[ctx];
    }
  }
  saveSessionsToFile();
}

/**
 * 删除会话（用于 /new 命令）
 */
export function deleteSession(channelId: string): boolean {
  const appId = data.activeByContext[channelId];
  if (appId) {
    delete data.activeByContext[channelId];
    saveSessionsToFile();
    return true;
  }
  return false;
}

/**
 * 获取活跃的 appSessionId。如果不存在则创建新会话
 */
export function ensureSession(
  contextKey: string,
  opts?: { platform?: string; scope?: SessionScope; backend?: string }
): string {
  const existing = data.activeByContext[contextKey];
  if (existing && data.sessions[existing]) {
    return existing;
  }
  return createSession(contextKey, opts);
}

/**
 * 获取所有会话列表（用于侧边栏）
 */
export function listAllSessions(): SessionEntry[] {
  return Object.values(data.sessions)
    .filter((s) => !s.archived)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * 获取会话数量
 */
export function getSessionCount(): number {
  return Object.keys(data.sessions).length;
}

/**
 * 清除所有会话（用于测试）
 */
export function clearSessions(): void {
  data = { activeByContext: {}, sessions: {} };
  sessionsPath = null;
}
