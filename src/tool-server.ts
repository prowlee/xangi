/**
 * xangi Tool Server — 面向 Claude Code 的 HTTP 端点
 *
 * 在 xangi 进程内启动，提供 Discord/调度/系统操作的 HTTP API。
 * Claude Code 通过 Bash 工具使用 xangi-cmd 向该服务器查询。
 *
 * 端口由操作系统自动分配（无冲突）。启动后，
 * 将连接 URL 设置到 process.env.XANGI_TOOL_SERVER 中，
 * 并传递给使用 xangi-cmd 的子进程。
 */
import { createServer, type Server } from 'http';
import { discordApi } from './cli/discord-api.js';
import { scheduleCmd } from './cli/schedule-cmd.js';
import { systemCmd } from './cli/system-cmd.js';

let server: Server | null = null;

interface ToolRequest {
  command: string;
  flags: Record<string, string>;
  context?: {
    channelId?: string;
  };
}

/**
 * 解析请求体
 */
async function parseBody(req: import('http').IncomingMessage): Promise<ToolRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString();
  if (!raw) throw new Error('请求体为空');
  return JSON.parse(raw) as ToolRequest;
}

/**
 * 路由并执行命令
 */
async function executeCommand(
  command: string,
  flags: Record<string, string>,
  context?: ToolRequest['context']
): Promise<string> {
  if (command.startsWith('discord_') || command === 'media_send') {
    return discordApi(command, flags, context);
  } else if (command.startsWith('schedule_')) {
    return scheduleCmd(command, flags);
  } else if (command.startsWith('system_')) {
    return systemCmd(command, flags);
  } else {
    throw new Error(`未知命令: ${command}`);
  }
}

/**
 * 启动 Tool Server（端口自动分配）
 */
export function startToolServer(): void {
  server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    // 健康检查
    if (req.url === '/health') {
      const addr = server?.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok', port }));
      return;
    }

    // 工具执行端点
    if (req.url === '/api/execute' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const { command, flags, context } = body;

        if (!command) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'command 参数是必需的' }));
          return;
        }

        console.log(`[tool-server] ${command} ${JSON.stringify(flags || {})}`);
        const result = await executeCommand(command, flags || {}, context);

        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, result }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[tool-server] 错误: ${message}`);
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: message }));
      }
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: '未找到' }));
  });

  // 端口0 = 操作系统自动分配（无冲突）
  server.listen(0, '0.0.0.0', () => {
    const addr = server!.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const serverUrl = `http://127.0.0.1:${port}`;
    process.env.XANGI_TOOL_SERVER = serverUrl;

    console.log(`[tool-server] 正在监听 http://0.0.0.0:${port}`);
  });
}

/**
 * 停止 Tool Server
 */
export function stopToolServer(): void {
  if (server) {
    server.close();
    server = null;
    delete process.env.XANGI_TOOL_SERVER;
  }
}
