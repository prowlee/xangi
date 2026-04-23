/**
 * 系统命令 CLI 模块
 *
 * 通过文件执行重启和配置更改。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

interface Settings {
  autoRestart?: boolean;
  [key: string]: unknown;
}

function getSettingsFilePath(): string {
  const dataDir = process.env.DATA_DIR || join(process.cwd(), '.xangi');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  return join(dataDir, 'settings.json');
}

function loadSettings(): Settings {
  const filePath = getSettingsFilePath();
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Settings;
  } catch {
    return {};
  }
}

function saveSettings(settings: Settings): void {
  const filePath = getSettingsFilePath();
  writeFileSync(filePath, JSON.stringify(settings, null, 2));
}

async function systemRestart(): Promise<string> {
  const settings = loadSettings();
  if (!settings.autoRestart) {
    return '⚠️ 自动重启已禁用。请先使用 system_settings --key autoRestart --value true 启用。';
  }

  // 创建重启触发文件（xangi 进程会监视该文件并重启）
  const dataDir = process.env.DATA_DIR || join(process.cwd(), '.xangi');
  writeFileSync(join(dataDir, 'restart-trigger'), Date.now().toString());

  return '🔄 已请求重启';
}

async function systemSettings(flags: Record<string, string>): Promise<string> {
  const key = flags['key'];
  const value = flags['value'];

  if (!key) {
    // 显示设置列表
    const settings = loadSettings();
    const entries = Object.entries(settings)
      .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
      .join('\n');
    return `⚙️ 当前设置:\n${entries || '  (无)'}`;
  }

  if (value === undefined) {
    throw new Error('指定 --key 时必须同时指定 --value');
  }

  const settings = loadSettings();

  // 类型转换
  let typedValue: unknown;
  if (value === 'true') typedValue = true;
  else if (value === 'false') typedValue = false;
  else if (!isNaN(Number(value))) typedValue = Number(value);
  else typedValue = value;

  settings[key] = typedValue;
  saveSettings(settings);

  return `⚙️ 已更新设置: ${key} = ${JSON.stringify(typedValue)}`;
}

// ─── 路由器 ─────────────────────────────────────────────────────────

export async function systemCmd(command: string, flags: Record<string, string>): Promise<string> {
  switch (command) {
    case 'system_restart':
      return systemRestart();
    case 'system_settings':
      return systemSettings(flags);
    default:
      throw new Error(`未知的系统命令: ${command}`);
  }
}
