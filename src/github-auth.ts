/**
 * GitHub App 认证
 *
 * 如果配置了 GitHub App，则自动生成 gh 包装脚本，
 * 并将其插入到 Agent 的 PATH 中。每次执行 gh 时动态生成 Token。
 * 如果未配置，则直接使用现有的 gh 认证。
 */
import { writeFileSync, mkdirSync, chmodSync, existsSync } from 'fs';
import { join, dirname } from 'path';

interface GitHubAppConfig {
  appId: string;
  installationId: string;
  privateKeyPath: string;
}

let appConfig: GitHubAppConfig | null = null;

// 包装脚本的存放路径
const WRAPPER_DIR = '/tmp/xangi-gh-wrapper';
const WRAPPER_PATH = join(WRAPPER_DIR, 'gh');

// Token 生成脚本
const TOKEN_SCRIPT_PATH = join(WRAPPER_DIR, 'generate-token.cjs');

/**
 * 初始化 GitHub App 配置并生成包装器
 */
export function initGitHubAuth(): void {
  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;

  if (appId && installationId && privateKeyPath) {
    // Docker 环境下使用挂载点的固定路径
    const dockerPemPath = '/secrets/github-app.pem';
    const resolvedKeyPath = existsSync(dockerPemPath) ? dockerPemPath : privateKeyPath;
    appConfig = { appId, installationId, privateKeyPath: resolvedKeyPath };
    generateWrapper(appConfig);
    console.log(`[github-auth] GitHub App 模式已启用 (App ID: ${appId})`);
  } else {
    console.log('[github-auth] 使用默认的 gh 认证');
  }
}

/**
 * 检查 GitHub App 是否已启用
 */
export function isGitHubAppEnabled(): boolean {
  return appConfig !== null;
}

/**
 * 需要添加到 Agent PATH 中的目录
 * App 模式：返回包装器目录
 * 普通模式：返回 undefined
 */
export function getGitHubWrapperDir(): string | undefined {
  return appConfig ? WRAPPER_DIR : undefined;
}

/**
 * 获取需要传递给 Agent 进程的环境变量
 * App 模式：将包装器目录添加到 PATH 头部
 * 普通模式：返回空对象
 */
export function getGitHubEnv(
  baseEnv: NodeJS.ProcessEnv | Record<string, string>
): Record<string, string> {
  if (!appConfig) return {};
  const currentPath = baseEnv['PATH'] || process.env.PATH || '';
  return { PATH: `${WRAPPER_DIR}:${currentPath}` };
}

/**
 * 生成包装器脚本和 Token 生成脚本
 */
function generateWrapper(config: GitHubAppConfig): void {
  mkdirSync(WRAPPER_DIR, { recursive: true });

  // Node.js Token 生成脚本（CommonJS 格式，使用 @octokit/auth-app）
  const tokenScript = `const { createAppAuth } = require('@octokit/auth-app');
const { readFileSync } = require('fs');
(async () => {
  const auth = createAppAuth({
    appId: '${config.appId}',
    privateKey: readFileSync('${config.privateKeyPath}', 'utf-8'),
    installationId: ${config.installationId},
  });
  const { token } = await auth({ type: 'installation' });
  process.stdout.write(token);
})();
`;
  writeFileSync(TOKEN_SCRIPT_PATH, tokenScript, 'utf-8');

  // gh 包装器 shell 脚本
  // 使用 CJS 格式，通过 NODE_PATH 引用 node_modules
  const xangiDir = join(dirname(new URL(import.meta.url).pathname), '..');
  const wrapper = `#!/bin/bash
export GH_TOKEN="$(NODE_PATH="${xangiDir}/node_modules" node "${TOKEN_SCRIPT_PATH}")"
if [ -z "$GH_TOKEN" ]; then
  echo "Error: Failed to generate GitHub App token" >&2
  exit 1
fi
echo "[github-auth] Using GitHub App token (App ID: ${config.appId})" >&2
exec "$(which -a gh | grep -v "${WRAPPER_DIR}" | head -1)" "$@"
`;
  writeFileSync(WRAPPER_PATH, wrapper, 'utf-8');
  chmodSync(WRAPPER_PATH, 0o755);
}
