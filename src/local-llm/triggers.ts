/**
 * Triggers — 在 chat 模式下通过魔法词触发功能
 *
 * 从工作区的 triggers/ 目录读取 trigger.yaml，
 * 从 LLM 响应文本中检测触发词并执行 handler 脚本。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

const EXEC_TIMEOUT_MS = parseInt(process.env.EXEC_TIMEOUT_MS ?? '120000', 10);

export interface Trigger {
  name: string;
  description: string;
  handler: string;
  /** trigger.yaml 所在目录的绝对路径 */
  path: string;
}

/**
 * 扫描工作区的 triggers/ 目录并读取 trigger 定义。
 * 如果 triggers/ 目录不存在，则返回空数组。
 */
export function loadTriggers(workdir: string): Trigger[] {
  const triggersDir = join(workdir, 'triggers');
  if (!existsSync(triggersDir) || !statSync(triggersDir).isDirectory()) {
    return [];
  }

  const triggers: Trigger[] = [];
  let entries: string[];
  try {
    entries = readdirSync(triggersDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const entryPath = join(triggersDir, entry);
    if (!statSync(entryPath).isDirectory()) continue;

    const yamlPath = join(entryPath, 'trigger.yaml');
    if (!existsSync(yamlPath)) continue;

    try {
      const content = readFileSync(yamlPath, 'utf-8');
      const parsed = parseYaml(content) as Record<string, unknown>;

      if (!parsed.name || !parsed.handler) {
        console.warn(`[triggers] ${entry} 中的 trigger.yaml 无效：缺少必要字段`);
        continue;
      }

      triggers.push({
        name: String(parsed.name),
        description: String(parsed.description || ''),
        handler: String(parsed.handler),
        path: entryPath,
      });

      console.log(`[triggers] 已加载: ${parsed.name}`);
    } catch (err) {
      console.warn(
        `[triggers] 解析 ${yamlPath} 失败: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return triggers;
}

/**
 * 执行触发器的 handler 脚本并返回结果。
 * handler 以工作区根目录作为 cwd 执行。
 */
export function executeTrigger(
  trigger: Trigger,
  args: string,
  workdir: string
): Promise<{ success: boolean; output: string }> {
  const handlerPath = join(trigger.path, trigger.handler);

  return new Promise((resolve) => {
    const argv = args ? args.split(/\s+/) : [];
    execFile(
      'bash',
      [handlerPath, ...argv],
      {
        cwd: workdir,
        timeout: EXEC_TIMEOUT_MS,
        env: { ...process.env },
      },
      (error, stdout, stderr) => {
        if (error) {
          const errMsg = stderr || error.message;
          console.error(`[triggers] 触发器 ${trigger.name} 执行失败: ${errMsg}`);
          resolve({ success: false, output: `错误: ${errMsg}` });
        } else {
          resolve({ success: true, output: stdout });
        }
      }
    );
  });
}

/**
 * 将触发器转换为 ToolHandler（用于工具模式）。
 * 使 LLM 可以通过 function calling 调用触发器。
 */
export function triggersToToolHandlers(
  triggers: Trigger[],
  workdir: string
): import('./types.js').ToolHandler[] {
  return triggers.map((t) => ({
    name: t.name,
    description: t.description || `执行 ${t.name} 触发器`,
    parameters: {
      type: 'object' as const,
      properties: {
        args: { type: 'string', description: '传递给触发器处理器的参数' },
      },
      required: [] as string[],
    },
    async execute(
      args: Record<string, unknown>,
      _context: import('./types.js').ToolContext
    ): Promise<import('./types.js').ToolResult> {
      const triggerArgs = String(args.args || '');
      const result = await executeTrigger(t, triggerArgs, workdir);
      return {
        success: result.success,
        output: result.output,
        error: result.success ? undefined : result.output,
      };
    },
  }));
}
