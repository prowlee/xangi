/**
 * 危险命令检测 + Discord/Slack 批准流程
 *
 * 模式从 approval-patterns.json 读取。
 * 设置 APPROVAL_ENABLED=true 启用（默认禁用）。
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/** 危险命令的模式定义 */
export interface DangerPattern {
  command: string;
  description: string;
  category: string;
}

/**
 * 从 approval-patterns.json 读取模式
 */
function loadPatternsFromFile(): DangerPattern[] {
  const paths = [
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'approval-patterns.json'),
    join(dirname(fileURLToPath(import.meta.url)), 'approval-patterns.json'),
  ];
  for (const filePath of paths) {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as DangerPattern[];
    } catch {
      // 继续尝试下一个路径
    }
  }
  console.warn('[approval] Failed to load approval-patterns.json, using empty patterns');
  return [];
}

/** 敏感文件模式（用于 Write/Edit 检测） */
const SENSITIVE_FILE_PATTERNS = /\.env$|credentials|\.pem$|\.key$/;

/** 有效的模式列表 */
let activePatterns: DangerPattern[] = loadPatternsFromFile();

/** 批准功能的启用/禁用（默认禁用） */
let approvalEnabled = false;

/**
 * 设置批准功能启用/禁用
 */
export function setApprovalEnabled(enabled: boolean): void {
  approvalEnabled = enabled;
  if (enabled && activePatterns.length === 0) {
    activePatterns = loadPatternsFromFile();
  }
  console.log(`[approval] ${enabled ? `Enabled (${activePatterns.length} patterns)` : 'Disabled'}`);
}

/**
 * 批准功能是否启用
 */
export function isApprovalEnabled(): boolean {
  return approvalEnabled;
}

/**
 * 重新加载模式
 */
export function reloadPatterns(): void {
  activePatterns = loadPatternsFromFile();
  console.log(`[approval] Reloaded ${activePatterns.length} patterns`);
}

/**
 * 获取当前模式列表
 */
export function getDangerPatterns(): DangerPattern[] {
  return [...activePatterns];
}

export interface DangerousCommand {
  command: string;
  matches: string[];
}

/**
 * 判断命令是否危险
 */
export function detectDangerousCommand(input: string): DangerousCommand | null {
  if (!approvalEnabled) return null;
  const lower = input.toLowerCase();
  const matches: string[] = [];
  for (const { command: cmd, description } of activePatterns) {
    if (lower.includes(cmd.toLowerCase())) {
      matches.push(description);
    }
  }
  return matches.length > 0 ? { command: input, matches } : null;
}

/**
 * 判断工具调用是否危险
 */
export function detectDangerousTool(
  toolName: string,
  toolInput: Record<string, unknown>
): DangerousCommand | null {
  if (!approvalEnabled) return null;
  if (toolName === 'Bash' && toolInput.command) {
    return detectDangerousCommand(String(toolInput.command));
  }
  if ((toolName === 'Write' || toolName === 'Edit') && toolInput.file_path) {
    const filePath = String(toolInput.file_path);
    if (SENSITIVE_FILE_PATTERNS.test(filePath)) {
      return { command: `${toolName}: ${filePath}`, matches: ['敏感文件修改'] };
    }
  }
  return null;
}

// --- 批准队列 ---

interface PendingApproval {
  id: string;
  channelId: string;
  danger: DangerousCommand;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingApprovals = new Map<string, PendingApproval>();

const APPROVAL_TIMEOUT_MS = 120_000; // 2分钟

let approvalCounter = 0;

/**
 * 创建批准请求，等待用户响应
 */
export function requestApproval(
  channelId: string,
  danger: DangerousCommand,
  sendApprovalMessage: (approvalId: string, danger: DangerousCommand) => void
): Promise<boolean> {
  return new Promise((resolve) => {
    const id = `approval_${++approvalCounter}`;

    const timer = setTimeout(() => {
      pendingApprovals.delete(id);
      console.log(`[approval] Timeout: ${id} (auto-denied)`);
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);

    pendingApprovals.set(id, { id, channelId, danger, resolve, timer });
    sendApprovalMessage(id, danger);
  });
}

/**
 * 处理批准/拒绝的响应
 */
export function resolveApproval(approvalId: string, approved: boolean): boolean {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) return false;

  clearTimeout(pending.timer);
  pendingApprovals.delete(approvalId);
  console.log(`[approval] ${approved ? 'Approved' : 'Denied'}: ${approvalId}`);
  pending.resolve(approved);
  return true;
}
