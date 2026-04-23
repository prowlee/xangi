/**
 * 加载工作区上下文（AGENTS.md, MEMORY.md）
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// CLAUDE.md 通常是 AGENTS.md 的符号链接，因此只读取 AGENTS.md 以避免重复
const CONTEXT_FILES = ['AGENTS.md', 'MEMORY.md'];

export function loadWorkspaceContext(workspace: string): string {
  const parts: string[] = [];

  for (const file of CONTEXT_FILES) {
    const filePath = join(workspace, file);
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        if (content.trim()) {
          parts.push(`## ${file}\n${content}`);
        }
      } catch {
        // 忽略读取错误
      }
    }
  }

  return parts.join('\n\n');
}
