/**
 * 本地 LLM 内置工具（exec, read, web_fetch）
 */
import { readFileSync, existsSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { promisify } from 'util';
import type { LLMTool, ToolContext, ToolResult, ToolHandler } from './types.js';
import { getSafeEnv } from '../safe-env.js';

// 延迟加载 child_process（避免与测试中的 vi.mock 冲突）
async function shellExec(
  command: string,
  options: { cwd?: string; timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string }> {
  const cp = await import('child_process');
  const execAsync = promisify(cp.exec);
  return execAsync(command, options);
}

// --- 可配置的超时时间 ---

const EXEC_TIMEOUT_MS = parseInt(process.env.EXEC_TIMEOUT_MS ?? '120000', 10);
const WEB_FETCH_TIMEOUT_MS = parseInt(process.env.WEB_FETCH_TIMEOUT_MS ?? '15000', 10);

// --- exec 工具 ---

const BLOCKED_PATTERNS = [
  /\brm\s+-rf\s+\/\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bformat\s+[a-z]:/i,
  />\s*\/dev\/[sh]d[a-z]/,
  /\bsudo\s+rm\s+-rf/,
  /:\(\)\s*\{.*\|\s*:\s*&\s*\}/, // fork bomb
];

const execToolHandler: ToolHandler = {
  name: 'exec',
  description: '执行 shell 命令并返回其输出。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
      cwd: { type: 'string', description: '工作目录（可选）' },
    },
    required: ['command'],
  },
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const command = args.command as string;
    const cwd = (args.cwd as string | undefined) ?? context.workspace;

    if (!command || typeof command !== 'string') {
      return { success: false, output: '', error: 'command 必须是非空字符串' };
    }
    if (BLOCKED_PATTERNS.some((p) => p.test(command))) {
      return { success: false, output: '', error: `出于安全考虑，命令被阻止: ${command}` };
    }

    try {
      const { stdout, stderr } = await shellExec(command, {
        cwd,
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: getSafeEnv(),
      });
      return { success: true, output: [stdout, stderr].filter(Boolean).join('\n').trim() };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return {
        success: false,
        output: [e.stdout, e.stderr].filter(Boolean).join('\n').trim(),
        error: e.message ?? String(err),
      };
    }
  },
};

// --- read 工具 ---

const readToolHandler: ToolHandler = {
  name: 'read',
  description: '读取文件内容。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（绝对路径或相对于工作区的路径）' },
    },
    required: ['path'],
  },
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const filePath = args.path as string;
    if (!filePath) return { success: false, output: '', error: 'path 参数是必需的' };

    const resolved = filePath.startsWith('/')
      ? filePath
      : resolve(join(context.workspace, filePath));
    if (!existsSync(resolved))
      return { success: false, output: '', error: `文件未找到: ${resolved}` };

    const stat = statSync(resolved);
    if (!stat.isFile()) return { success: false, output: '', error: `不是文件: ${resolved}` };
    if (stat.size > 512 * 1024)
      return { success: false, output: '', error: `文件过大: ${stat.size} 字节` };

    // JSON 文件过大时给出警告（建议使用 CLI 工具通过命令行查询）
    if (resolved.endsWith('.json') && stat.size > 5 * 1024)
      return {
        success: false,
        output: '',
        error: `JSON 文件过大 (${stat.size} 字节)。请使用 CLI 工具查询特定条目，而不是读取整个文件。`,
      };

    try {
      return { success: true, output: readFileSync(resolved, 'utf-8') };
    } catch (err) {
      return { success: false, output: '', error: String(err) };
    }
  },
};

// --- web_fetch 工具 ---

const webFetchToolHandler: ToolHandler = {
  name: 'web_fetch',
  description: '获取 URL 的内容。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要获取的 URL' },
      method: {
        type: 'string',
        description: 'HTTP 方法（默认: GET）',
        enum: ['GET', 'POST', 'PUT', 'DELETE'],
      },
      body: { type: 'string', description: 'POST/PUT 的请求体（JSON 字符串）' },
    },
    required: ['url'],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const url = args.url as string;
    const method = (args.method as string) ?? 'GET';
    const body = args.body as string | undefined;

    if (!url) return { success: false, output: '', error: 'url 参数是必需的' };

    try {
      new URL(url);
    } catch {
      return { success: false, output: '', error: `无效的 URL: ${url}` };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);

    try {
      const opts: RequestInit = {
        method,
        signal: controller.signal,
        headers: {
          'User-Agent': 'xangi/local-llm',
          Accept: 'text/html,application/json,text/plain,*/*',
        },
      };
      if (body && ['POST', 'PUT'].includes(method)) {
        opts.body = body;
        (opts.headers as Record<string, string>)['Content-Type'] = 'application/json';
      }

      const res = await fetch(url, opts);
      let text = await res.text();
      if (text.length > 100 * 1024) text = text.slice(0, 100 * 1024) + '\n... [已截断]';

      if (!res.ok) return { success: false, output: text, error: `HTTP ${res.status}` };
      return { success: true, output: text };
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError')
        return { success: false, output: '', error: '请求超时' };
      return { success: false, output: '', error: String(err) };
    } finally {
      clearTimeout(timeoutId);
    }
  },
};

// --- 注册表 ---

const ALL_TOOLS: ToolHandler[] = [execToolHandler, readToolHandler, webFetchToolHandler];

// 动态添加的工具（如触发器生成）
let dynamicTools: ToolHandler[] = [];

export function getBuiltinTools(): ToolHandler[] {
  return ALL_TOOLS;
}

/**
 * 注册动态工具（用于将触发器工具化等）
 */
export function registerDynamicTools(tools: ToolHandler[]): void {
  dynamicTools = tools;
}

/**
 * 获取所有工具（内置 + 动态）
 */
export function getAllTools(): ToolHandler[] {
  return [...ALL_TOOLS, ...dynamicTools];
}

export function toLLMTools(handlers: ToolHandler[]): LLMTool[] {
  return handlers.map((h) => ({
    name: h.name,
    description: h.description,
    parameters: h.parameters,
  }));
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  const allTools = getAllTools();
  const handler = allTools.find((t) => t.name === name);
  if (!handler) return { success: false, output: '', error: `未知工具: ${name}` };

  try {
    return await handler.execute(args, context);
  } catch (err) {
    return { success: false, output: '', error: `工具错误: ${String(err)}` };
  }
}
