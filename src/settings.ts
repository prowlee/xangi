import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

export interface Settings {
  autoRestart: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  autoRestart: true,
};

let settingsPath: string | null = null;
let cachedSettings: Settings | null = null;

/**
 * 初始化 settings.json 的路径
 * 保存在 workdir（WORKSPACE_PATH）目录下
 */
export function initSettings(workdir: string): void {
  settingsPath = join(workdir, 'settings.json');
}

/**
 * 获取 settings.json 的路径
 */
export function getSettingsPath(): string {
  if (!settingsPath) {
    throw new Error('设置未初始化。请先调用 initSettings(workdir)。');
  }
  return settingsPath;
}

/**
 * 读取设置（带缓存）
 */
export function loadSettings(): Settings {
  if (cachedSettings) return { ...cachedSettings };

  const path = getSettingsPath();
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    cachedSettings = {
      autoRestart: parsed.autoRestart ?? DEFAULT_SETTINGS.autoRestart,
    };
    return { ...cachedSettings };
  } catch {
    // 文件不存在或解析错误 → 使用默认值
    cachedSettings = { ...DEFAULT_SETTINGS };
    return { ...cachedSettings };
  }
}

/**
 * 保存设置
 */
export function saveSettings(settings: Partial<Settings>): Settings {
  const current = loadSettings();
  const merged: Settings = { ...current, ...settings };

  const path = getSettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n', 'utf-8');

  cachedSettings = merged;
  console.log(`[xangi] 设置已保存: ${JSON.stringify(merged)}`);
  return { ...merged };
}

/**
 * 格式化设置，返回用于显示的字符串
 */
export function formatSettings(settings: Settings): string {
  const lines = ['⚙️ **当前设置**', `- 自动重启: ${settings.autoRestart ? '✅ 开启' : '❌ 关闭'}`];
  return lines.join('\n');
}

/**
 * 清除缓存（用于测试）
 */
export function clearSettingsCache(): void {
  cachedSettings = null;
  settingsPath = null;
}
