/**
 * Web 聊天 UI — 带 ChatGPT 风格侧边栏
 *
 * 从浏览器访问 localhost:PORT 与 AI 聊天。
 * 基于会话的日志（logs/sessions/<appSessionId>.jsonl）进行管理。
 */
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import type { AgentRunner } from './agent-runner.js';
import {
  getSession,
  setSession,
  deleteSession,
  ensureSession,
  listAllSessions,
  getSessionEntry,
  getActiveSessionId,
  updateSessionTitle,
  incrementMessageCount,
  createSession,
  setProviderSessionId,
  activateSession,
  removeSession,
} from './sessions.js';
import { readSessionMessages } from './transcript-logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_PORT = 18888;
const WEB_CHANNEL_ID = 'web-chat';

// 用于在恢复后向第一条消息注入会话历史记录的标志
let resumedAppSessionId: string | null = null;

interface WebChatOptions {
  agentRunner: AgentRunner;
  port?: number;
}

export function startWebChat(options: WebChatOptions): void {
  const { agentRunner } = options;
  const port = options.port || parseInt(process.env.WEB_CHAT_PORT || String(DEFAULT_PORT), 10);
  const workdir = process.env.WORKSPACE_PATH || process.cwd();

  const server = createServer(async (req, res) => {
    const rawUrl = req.url || '/';
    const url = rawUrl.split('?')[0];

    // CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // 静态文件服务
    if (url === '/' || url === '/index.html') {
      try {
        const htmlPath = join(__dirname, '..', 'web', 'index.html');
        const html = readFileSync(htmlPath, 'utf-8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
        });
        res.end(html);
      } catch {
        res.writeHead(500);
        res.end('web/index.html 未找到');
      }
      return;
    }

    // 健康检查
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', port }));
      return;
    }

    // GET /api/sessions — 会话列表
    if (url === '/api/sessions' && req.method === 'GET') {
      // sessions.json 中注册的会话（排除标题无意义的）
      const managed = listAllSessions()
        .filter((s) => {
          const t = s.title || s.contextKey;
          return t && !/^\d{10,}$/.test(t);
        })
        .map((s) => ({
          id: s.id,
          title: s.title || s.contextKey,
          platform: s.platform,
          contextKey: s.contextKey,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          messageCount: s.messageCount,
          isActive: getActiveSessionId(s.contextKey) === s.id,
        }));
      const managedIds = new Set(managed.map((s) => s.id));

      // 也包括 logs/sessions/ 目录中的日志文件（迁移数据等）
      const sessionsDir = join(workdir, 'logs', 'sessions');
      const unmanaged: typeof managed = [];
      if (existsSync(sessionsDir)) {
        for (const file of readdirSync(sessionsDir)) {
          if (!file.endsWith('.jsonl')) continue;
          const id = file.replace('.jsonl', '');
          if (managedIds.has(id)) continue;
          const filePath = join(sessionsDir, file);
          const stat = statSync(filePath);
          // 从第一行获取标题
          let title = id;
          try {
            const firstLine = readFileSync(filePath, 'utf-8').split('\n')[0];
            if (firstLine) {
              const entry = JSON.parse(firstLine);
              if (entry.role === 'user' && typeof entry.content === 'string') {
                title = entry.content
                  .replace(/^\[平台: [^\]]*\]\n?/, '')
                  .replace(/^\[频道: [^\]]*\]\n?/, '')
                  .replace(/^\[发言者: [^\]]*\]\n?/, '')
                  .replace(/^\[当前时间: [^\]]*\]\n?/, '')
                  .trim()
                  .slice(0, 50);
              }
            }
          } catch {
            /* 忽略 */
          }
          // 跳过无意义的标题（频道 ID、空、保持为 ID 的）
          if (!title || title === id || /^\d{10,}$/.test(title)) continue;
          unmanaged.push({
            id,
            title,
            platform: 'discord',
            contextKey: '',
            createdAt: stat.birthtime.toISOString(),
            updatedAt: stat.mtime.toISOString(),
            messageCount: 0,
            isActive: false,
          });
        }
      }

      // managed 优先，unmanaged 按更新时间降序排列
      unmanaged.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const sessions = [...managed, ...unmanaged];

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions }));
      return;
    }

    // GET /api/sessions/:id — 会话详情（消息列表）
    if (url.startsWith('/api/sessions/') && req.method === 'GET') {
      const appSessionId = decodeURIComponent(url.replace('/api/sessions/', ''));
      const entry = getSessionEntry(appSessionId);
      const messages = readSessionMessages(workdir, appSessionId).map((m) => {
        const isObj = typeof m.content === 'object' && m.content !== null;
        const obj = isObj ? (m.content as Record<string, unknown>) : {};
        return {
          id: m.id,
          role: m.role,
          content: isObj ? (obj.result ?? JSON.stringify(m.content)) : m.content,
          createdAt: m.createdAt,
          usage: isObj
            ? {
                num_turns: obj.num_turns,
                duration_ms: obj.duration_ms,
                total_cost_usd: obj.total_cost_usd,
              }
            : undefined,
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: appSessionId,
          title:
            entry?.title ||
            messages
              .find((m) => m.role === 'user')
              ?.content?.toString()
              .slice(0, 50) ||
            appSessionId,
          platform: entry?.platform,
          messages,
        })
      );
      return;
    }

    // PATCH /api/sessions/:id — 修改标题
    if (url.startsWith('/api/sessions/') && req.method === 'PATCH') {
      const appSessionId = decodeURIComponent(url.replace('/api/sessions/', ''));
      const body = await readBody(req);
      if (body.title) {
        updateSessionTitle(appSessionId, body.title);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /api/sessions — 新建会话
    if (url === '/api/sessions' && req.method === 'POST') {
      agentRunner.destroy?.(WEB_CHANNEL_ID);
      deleteSession(WEB_CHANNEL_ID);
      const newAppId = createSession(WEB_CHANNEL_ID, { platform: 'web' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessionId: newAppId }));
      return;
    }

    // POST /api/sessions/:id/resume — 恢复会话
    if (url.match(/^\/api\/sessions\/[^/]+\/resume$/) && req.method === 'POST') {
      const targetId = decodeURIComponent(url.replace('/api/sessions/', '').replace('/resume', ''));
      const entry = getSessionEntry(targetId);
      const providerSid = entry?.agent?.providerSessionId;

      // 切换 activeByContext（不销毁运行器 = 保持进程上下文）
      if (providerSid) {
        setSession(WEB_CHANNEL_ID, providerSid);
      }
      activateSession(WEB_CHANNEL_ID, targetId);
      resumedAppSessionId = targetId;

      console.log(`[web-chat] 恢复会话 ${targetId}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessionId: targetId }));
      return;
    }

    // DELETE /api/sessions/:id — 删除会话
    if (url.startsWith('/api/sessions/') && !url.includes('/resume') && req.method === 'DELETE') {
      const targetId = decodeURIComponent(url.replace('/api/sessions/', ''));
      removeSession(targetId);

      // 同时删除日志文件
      const logPath = join(workdir, 'logs', 'sessions', `${targetId}.jsonl`);
      if (existsSync(logPath)) {
        const { unlinkSync } = await import('fs');
        unlinkSync(logPath);
      }

      console.log(`[web-chat] 已删除会话 ${targetId}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /api/upload — 文件上传
    if (url === '/api/upload' && req.method === 'POST') {
      try {
        const uploadDir = join(workdir, 'tmp', 'web-uploads');
        mkdirSync(uploadDir, { recursive: true });

        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const body = Buffer.concat(chunks);

        // 解析 multipart/form-data（简易实现）
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(.+)/);
        if (!boundaryMatch) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Content-Type 中没有 boundary' }));
          return;
        }
        const boundary = '--' + boundaryMatch[1];
        const parts = body.toString('binary').split(boundary);

        const files: { name: string; path: string }[] = [];
        for (const part of parts) {
          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd === -1) continue;
          const headers = part.slice(0, headerEnd);
          const filenameMatch = headers.match(/filename="([^"]+)"/);
          if (!filenameMatch) continue;

          const filename = filenameMatch[1];
          const ext = extname(filename).toLowerCase();
          const safeName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
          const filePath = join(uploadDir, safeName);

          // 提取二进制数据（移除末尾的 \r\n）
          const dataStart = headerEnd + 4;
          const dataEnd = part.length - 2; // 末尾的 \r\n
          const fileData = Buffer.from(part.slice(dataStart, dataEnd), 'binary');
          writeFileSync(filePath, fileData);

          files.push({ name: filename, path: filePath });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files }));
      } catch (err) {
        console.error('[web-chat] 上传错误:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '上传失败' }));
      }
      return;
    }

    // GET /api/files/* — 提供已上传的文件
    if (url.startsWith('/api/files/') && req.method === 'GET') {
      const filename = decodeURIComponent(url.replace('/api/files/', ''));
      const filePath = join(workdir, 'tmp', 'web-uploads', filename);
      if (!existsSync(filePath) || filename.includes('..')) {
        res.writeHead(404);
        res.end('未找到');
        return;
      }
      const ext = extname(filePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.pdf': 'application/pdf',
        '.mp3': 'audio/mpeg',
        '.mp4': 'video/mp4',
        '.wav': 'audio/wav',
      };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      res.end(readFileSync(filePath));
      return;
    }

    // GET /api/workspace-file?path= — 提供工作区内的文件（用于 MEDIA: 显示）
    if (url.startsWith('/api/workspace-file') && req.method === 'GET') {
      const urlObj = new URL(rawUrl, `http://${req.headers.host}`);
      const filePath = urlObj.searchParams.get('path') || '';
      // 安全限制：只允许工作区内的文件
      if (!filePath || !filePath.startsWith(workdir) || filePath.includes('..')) {
        res.writeHead(403);
        res.end('禁止访问');
        return;
      }
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end('未找到');
        return;
      }
      const ext = extname(filePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.pdf': 'application/pdf',
        '.mp3': 'audio/mpeg',
        '.mp4': 'video/mp4',
        '.wav': 'audio/wav',
      };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      res.end(readFileSync(filePath));
      return;
    }

    // POST /api/chat — 发送消息（SSE 流式传输）
    if (url === '/api/chat' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const message = body.message || '';

        if (!message.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'message 参数是必需的' }));
          return;
        }

        console.log(`[web-chat] 消息: ${message.slice(0, 100)}`);

        const appSessionId = ensureSession(WEB_CHANNEL_ID, { platform: 'web' });
        const sessionId = getSession(WEB_CHANNEL_ID);

        // 恢复后的第一条消息：注入过去的对话历史
        let historyContext = '';
        if (resumedAppSessionId) {
          const pastMessages = readSessionMessages(workdir, resumedAppSessionId);
          // 注入最近10条对话作为上下文
          const recent = pastMessages.slice(-10);
          if (recent.length > 0) {
            const lines = recent
              .map((m) => {
                const content =
                  typeof m.content === 'object'
                    ? ((m.content as Record<string, unknown>).result as string) || ''
                    : String(m.content);
                const cleaned = content
                  .replace(/^\[平台: [^\]]*\]\n?/m, '')
                  .replace(/^\[频道: [^\]]*\]\n?/m, '')
                  .replace(/^\[发言者: [^\]]*\]\n?/m, '')
                  .replace(/^\[当前时间: [^\]]*\]\n?/m, '')
                  .trim();
                return `${m.role === 'user' ? '用户' : 'AI'}: ${cleaned.slice(0, 200)}`;
              })
              .join('\n');
            historyContext = `\n[以下是本次会话最近的对话历史。请基于此上下文进行回复]\n${lines}\n[历史结束]\n\n`;
          }
          resumedAppSessionId = null;
        }

        const prompt = `[平台: Web]\n${historyContext}${message}`;

        // SSE 头
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });

        const sendSSE = (event: string, data: unknown) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        try {
          const result = await agentRunner.runStream(
            prompt,
            {
              onText: (_chunk, fullText) => {
                sendSSE('text', { fullText });
              },
              onToolUse: (toolName, toolInput) => {
                const inputSummary =
                  Object.keys(toolInput).length > 0
                    ? ` ${JSON.stringify(toolInput).slice(0, 100)}`
                    : '';
                sendSSE('tool', { toolName, inputSummary });
              },
              onComplete: (completedResult) => {
                // 附加保存 providerSessionId
                setProviderSessionId(appSessionId, completedResult.sessionId);
                setSession(WEB_CHANNEL_ID, completedResult.sessionId);
                incrementMessageCount(appSessionId);

                // 第一条消息自动设置标题
                const entry = getSessionEntry(appSessionId);
                if (!entry?.title) {
                  updateSessionTitle(appSessionId, message.slice(0, 50));
                }
              },
              onError: (error) => {
                sendSSE('error', { message: error.message });
              },
            },
            {
              sessionId,
              channelId: WEB_CHANNEL_ID,
              appSessionId,
            }
          );

          // 完成事件（附带 usage 信息）
          const msgs = readSessionMessages(workdir, appSessionId);
          const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant');
          const usageObj =
            lastAssistant && typeof lastAssistant.content === 'object'
              ? (lastAssistant.content as Record<string, unknown>)
              : {};
          const usage = {
            num_turns: usageObj.num_turns,
            duration_ms: usageObj.duration_ms,
            total_cost_usd: usageObj.total_cost_usd,
          };

          sendSSE('done', {
            response: result.result,
            sessionId: appSessionId,
            usage,
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          sendSSE('error', { message: errorMsg });
        }
        res.end();
      } catch (err) {
        console.error('[web-chat] 错误:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: '内部服务器错误' }));
      }
      return;
    }

    res.writeHead(404);
    res.end('未找到');
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[web-chat] 聊天 UI: http://localhost:${port}`);
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readBody(req: import('http').IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
