import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';

/**
 * セッション管理（チャンネルID → セッション情報）
 * ファイルに永続化してプロセス再起動後も継続可能にする
 */

export type SessionScope = 'interactive' | 'scheduler';

export interface SessionEntry {
  sessionId: string;
  scope: SessionScope;
  bootId: string;
  updatedAt: string;
}

// 後方互換: 旧フォーマット（string）も読み込み可能
type RawSessionData = Record<string, string | SessionEntry>;

type SessionMap = Map<string, SessionEntry>;

let sessionsPath: string | null = null;
let sessions: SessionMap = new Map();
let currentBootId: string = randomUUID();

/**
 * sessions.json のパスを初期化
 * @param dataDir DATA_DIR または .xangi ディレクトリ
 */
export function initSessions(dataDir: string): void {
  sessionsPath = join(dataDir, 'sessions.json');
  currentBootId = randomUUID();
  loadSessionsFromFile();
  // 起動時: scheduler セッションをクリア（stateless化）
  purgeSchedulerSessions();
}

/**
 * 現在の bootId を取得
 */
export function getBootId(): string {
  return currentBootId;
}

/**
 * sessions.json のパスを取得
 */
export function getSessionsPath(): string {
  if (!sessionsPath) {
    throw new Error('Sessions not initialized. Call initSessions(dataDir) first.');
  }
  return sessionsPath;
}

/**
 * ファイルからセッションを読み込む（旧フォーマットとの後方互換あり）
 */
function loadSessionsFromFile(): void {
  const path = getSessionsPath();
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as RawSessionData;
      sessions = new Map();
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') {
          // 旧フォーマット: string → SessionEntry に変換
          sessions.set(key, {
            sessionId: value,
            scope: 'interactive',
            bootId: '', // 不明（旧データ）
            updatedAt: new Date().toISOString(),
          });
        } else {
          sessions.set(key, value);
        }
      }
      console.log(`[xangi] Loaded ${sessions.size} sessions from ${path}`);
    }
  } catch (err) {
    console.error('[xangi] Failed to load sessions:', err);
    sessions = new Map();
  }
}

/**
 * セッションをファイルに保存
 */
function saveSessionsToFile(): void {
  const path = getSessionsPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const obj: Record<string, SessionEntry> = {};
    for (const [key, value] of sessions) {
      obj[key] = value;
    }
    writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
  } catch (err) {
    console.error('[xangi] Failed to save sessions:', err);
  }
}

/**
 * scheduler スコープのセッションを全削除（起動時に呼ばれる）
 */
function purgeSchedulerSessions(): void {
  let purged = 0;
  for (const [key, entry] of sessions) {
    if (entry.scope === 'scheduler') {
      sessions.delete(key);
      purged++;
    }
  }
  if (purged > 0) {
    console.log(`[xangi] Purged ${purged} stale scheduler session(s)`);
    saveSessionsToFile();
  }
}

/**
 * セッションIDを取得
 */
export function getSession(channelId: string): string | undefined {
  return sessions.get(channelId)?.sessionId;
}

/**
 * セッション情報を取得
 */
export function getSessionEntry(channelId: string): SessionEntry | undefined {
  return sessions.get(channelId);
}

/**
 * セッションIDを設定（自動保存）
 */
export function setSession(
  channelId: string,
  sessionId: string,
  scope: SessionScope = 'interactive'
): void {
  sessions.set(channelId, {
    sessionId,
    scope,
    bootId: currentBootId,
    updatedAt: new Date().toISOString(),
  });
  saveSessionsToFile();
}

/**
 * セッションを削除（自動保存）
 */
export function deleteSession(channelId: string): boolean {
  const deleted = sessions.delete(channelId);
  if (deleted) {
    saveSessionsToFile();
  }
  return deleted;
}

/**
 * 全セッションをクリア（テスト用）
 */
export function clearSessions(): void {
  sessions.clear();
  sessionsPath = null;
}

/**
 * セッション数を取得
 */
export function getSessionCount(): number {
  return sessions.size;
}
