/**
 * Claude Code PreToolUse HTTP 钩子服务器
 *
 * 在 Claude Code 的 settings.json 中设置以下内容:
 * {
 *   "hooks": {
 *     "PreToolUse": [{
 *       "matcher": "Bash|Write|Edit",
 *       "type": "http",
 *       "url": "http://localhost:PORT/hooks/pre-tool-use",
 *       "timeout": 120
 *     }]
 *   }
 * }
 */
import { createServer, type Server } from 'http';
import { detectDangerousTool } from './approval.js';

const DEFAULT_PORT = 18181;

type ApprovalCallback = (
  toolName: string,
  toolInput: Record<string, unknown>,
  dangerDescription: string[]
) => Promise<boolean>;

let server: Server | null = null;
let approvalCallback: ApprovalCallback | null = null;

/**
 * 启动批准服务器
 */
export function startApprovalServer(callback: ApprovalCallback, port?: number): void {
  const listenPort = port || parseInt(process.env.APPROVAL_SERVER_PORT || String(DEFAULT_PORT), 10);
  approvalCallback = callback;

  server = createServer(async (req, res) => {
    // 健康检查
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', port: listenPort }));
      return;
    }

    console.log(`[approval-server] ${req.method} ${req.url}`);

    // PreToolUse 钩子端点
    if (req.url === '/hooks/pre-tool-use' && req.method === 'POST') {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const rawBody = Buffer.concat(chunks).toString();
        console.log(`[approval-server] Received: ${rawBody.slice(0, 500)}`);
        const body = JSON.parse(rawBody);

        const toolName = body.tool_name || body.toolName || '';
        const toolInput = body.tool_input || body.input || {};
        console.log(
          `[approval-server] Tool: ${toolName}, Input keys: ${Object.keys(toolInput).join(',')}`
        );

        // 危险命令判定
        const danger = detectDangerousTool(toolName, toolInput);

        if (!danger || !approvalCallback) {
          // 如果没有危险则允许（返回空响应即可）
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }

        // 等待批准
        console.log(
          `[approval-server] Dangerous tool detected: ${toolName} (${danger.matches.join(', ')})`
        );
        const approved = await approvalCallback(toolName, toolInput, danger.matches);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (approved) {
          res.end(
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
              },
            })
          );
        } else {
          res.end(
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: `Blocked: ${danger.matches.join(', ')}`,
              },
            })
          );
        }
      } catch (err) {
        console.error('[approval-server] Error:', err);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}'); // 出错时允许（空=成功）
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(listenPort, '127.0.0.1', () => {
    console.log(`[approval-server] Listening on http://127.0.0.1:${listenPort}`);
  });
}

/**
 * 停止批准服务器
 */
export function stopApprovalServer(): void {
  if (server) {
    server.close();
    server = null;
  }
}

/**
 * 获取批准服务器的端口
 */
export function getApprovalServerPort(): number {
  return parseInt(process.env.APPROVAL_SERVER_PORT || String(DEFAULT_PORT), 10);
}

/**
 * 发送 HTTP 请求到批准服务器以获取工具执行的批准
 * 从 Local LLM 后端调用（使用与 Claude Code 相同的批准服务器）
 */
export async function checkApprovalServer(
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<'allow' | 'deny'> {
  const port = getApprovalServerPort();
  try {
    const body = JSON.stringify({
      tool_name: toolName,
      tool_input: toolInput,
      hook_event_name: 'PreToolUse',
    });
    const response = await fetch(`http://127.0.0.1:${port}/hooks/pre-tool-use`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const result = (await response.json()) as Record<string, unknown>;
    const output = result.hookSpecificOutput as Record<string, unknown> | undefined;
    if (output?.permissionDecision === 'deny') {
      return 'deny';
    }
    return 'allow';
  } catch {
    // 无法连接到批准服务器时允许（故障开放）
    return 'allow';
  }
}
