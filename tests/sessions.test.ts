import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  initSessions,
  getSession,
  getSessionEntry,
  setSession,
  deleteSession,
  clearSessions,
  getSessionCount,
  getBootId,
} from '../src/sessions.js';

describe('sessions', () => {
  let testDir: string;

  beforeEach(() => {
    clearSessions();
    testDir = mkdtempSync(join(tmpdir(), 'sessions-test-'));
  });

  afterEach(() => {
    clearSessions();
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  describe('initSessions', () => {
    it('should initialize with empty sessions', () => {
      initSessions(testDir);
      expect(getSessionCount()).toBe(0);
    });

    it('should load existing sessions from file', () => {
      // 事前にファイルを作成
      const sessionsPath = join(testDir, 'sessions.json');
      const data = { 'channel-1': 'session-abc', 'channel-2': 'session-def' };
      require('fs').writeFileSync(sessionsPath, JSON.stringify(data));

      initSessions(testDir);
      expect(getSessionCount()).toBe(2);
      expect(getSession('channel-1')).toBe('session-abc');
      expect(getSession('channel-2')).toBe('session-def');
    });

    it('should migrate legacy string format to SessionEntry', () => {
      const sessionsPath = join(testDir, 'sessions.json');
      const data = { 'channel-1': 'session-abc' };
      require('fs').writeFileSync(sessionsPath, JSON.stringify(data));

      initSessions(testDir);
      const entry = getSessionEntry('channel-1');
      expect(entry).toBeDefined();
      expect(entry!.sessionId).toBe('session-abc');
      expect(entry!.scope).toBe('interactive');
      expect(entry!.bootId).toBe(''); // 旧データは bootId 不明
    });

    it('should load new format sessions', () => {
      const sessionsPath = join(testDir, 'sessions.json');
      const data = {
        'channel-1': {
          sessionId: 'session-abc',
          scope: 'interactive',
          bootId: 'boot-xyz',
          updatedAt: '2026-03-18T00:00:00Z',
        },
      };
      require('fs').writeFileSync(sessionsPath, JSON.stringify(data));

      initSessions(testDir);
      const entry = getSessionEntry('channel-1');
      expect(entry).toBeDefined();
      expect(entry!.sessionId).toBe('session-abc');
      expect(entry!.scope).toBe('interactive');
      expect(entry!.bootId).toBe('boot-xyz');
    });

    it('should purge scheduler sessions on init', () => {
      const sessionsPath = join(testDir, 'sessions.json');
      const data = {
        'channel-1': {
          sessionId: 'session-abc',
          scope: 'interactive',
          bootId: 'boot-old',
          updatedAt: '2026-03-18T00:00:00Z',
        },
        'channel-2': {
          sessionId: 'session-def',
          scope: 'scheduler',
          bootId: 'boot-old',
          updatedAt: '2026-03-18T00:00:00Z',
        },
      };
      require('fs').writeFileSync(sessionsPath, JSON.stringify(data));

      initSessions(testDir);
      // interactive は残る
      expect(getSession('channel-1')).toBe('session-abc');
      // scheduler はクリアされる
      expect(getSession('channel-2')).toBeUndefined();
      expect(getSessionCount()).toBe(1);
    });

    it('should generate a new bootId on each init', () => {
      initSessions(testDir);
      const bootId1 = getBootId();
      clearSessions();
      initSessions(testDir);
      const bootId2 = getBootId();
      expect(bootId1).not.toBe(bootId2);
    });
  });

  describe('getSession', () => {
    it('should return undefined for unknown channel', () => {
      initSessions(testDir);
      expect(getSession('unknown')).toBeUndefined();
    });

    it('should return session ID for known channel', () => {
      initSessions(testDir);
      setSession('channel-1', 'session-123');
      expect(getSession('channel-1')).toBe('session-123');
    });
  });

  describe('setSession', () => {
    it('should save session and persist to file', () => {
      initSessions(testDir);
      setSession('channel-1', 'session-123');

      // ファイルに保存されたか確認
      const sessionsPath = join(testDir, 'sessions.json');
      expect(existsSync(sessionsPath)).toBe(true);

      const saved = JSON.parse(readFileSync(sessionsPath, 'utf-8'));
      expect(saved['channel-1'].sessionId).toBe('session-123');
      expect(saved['channel-1'].scope).toBe('interactive');
      expect(saved['channel-1'].bootId).toBe(getBootId());
    });

    it('should update existing session', () => {
      initSessions(testDir);
      setSession('channel-1', 'session-old');
      setSession('channel-1', 'session-new');

      expect(getSession('channel-1')).toBe('session-new');
    });

    it('should save with scheduler scope', () => {
      initSessions(testDir);
      setSession('channel-1', 'session-123', 'scheduler');

      const entry = getSessionEntry('channel-1');
      expect(entry!.scope).toBe('scheduler');
    });
  });

  describe('deleteSession', () => {
    it('should delete session and persist', () => {
      initSessions(testDir);
      setSession('channel-1', 'session-123');
      expect(getSession('channel-1')).toBe('session-123');

      const deleted = deleteSession('channel-1');
      expect(deleted).toBe(true);
      expect(getSession('channel-1')).toBeUndefined();

      // ファイルからも削除されたか確認
      const sessionsPath = join(testDir, 'sessions.json');
      const saved = JSON.parse(readFileSync(sessionsPath, 'utf-8'));
      expect(saved['channel-1']).toBeUndefined();
    });

    it('should return false for unknown channel', () => {
      initSessions(testDir);
      const deleted = deleteSession('unknown');
      expect(deleted).toBe(false);
    });
  });

  describe('persistence across restarts', () => {
    it('should persist sessions across init calls', () => {
      initSessions(testDir);
      setSession('channel-1', 'session-abc');
      setSession('channel-2', 'session-def');

      // シミュレート: プロセス再起動
      clearSessions();
      initSessions(testDir);

      expect(getSession('channel-1')).toBe('session-abc');
      expect(getSession('channel-2')).toBe('session-def');
    });

    it('should purge scheduler sessions but keep interactive on restart', () => {
      initSessions(testDir);
      setSession('channel-1', 'session-abc', 'interactive');
      setSession('channel-2', 'session-def', 'scheduler');

      // シミュレート: プロセス再起動
      clearSessions();
      initSessions(testDir);

      expect(getSession('channel-1')).toBe('session-abc');
      expect(getSession('channel-2')).toBeUndefined();
    });
  });
});
