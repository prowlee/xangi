/**
 * 传递给 AI Agent 的环境变量白名单
 * 只有列出的变量会被传递给 CLI/exec 进程
 * 绝对不要添加密钥（Token、API Key 等）
 */
export const ALLOWED_ENV_KEYS = [
  // Shell 基本环境
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TZ',
  // Node.js
  'NODE_ENV',
  'NODE_PATH',
  // xangi 运行用
  'WORKSPACE_PATH',
  'AGENT_BACKEND',
  'AGENT_MODEL',
  'SKIP_PERMISSIONS',
  'DATA_DIR',
  'XANGI_TOOL_SERVER',
  'XANGI_CHANNEL_ID',
];

/**
 * 使用白名单方式，只返回安全的环境变量
 */
export function getSafeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }

  // 将 xangi-cmd (bin/) 添加到 PATH
  if (env.PATH && XANGI_BIN_DIR) {
    env.PATH = `${XANGI_BIN_DIR}:${env.PATH}`;
  }

  return env;
}

// 在启动时解析 xangi 的 bin/ 目录
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const XANGI_BIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin');
