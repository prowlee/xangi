/**
 * 日程操作 CLI 模块
 *
 * 直接操作 .xangi/schedules.json 文件。
 * 由于 Scheduler 类会监听文件变化，
 * 只要更新文件，正在运行的 xangi 进程就会自动重新加载。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parseScheduleInput, formatScheduleList } from '../scheduler.js';

interface Schedule {
  id: string;
  type: 'cron' | 'once' | 'startup';
  expression?: string;
  runAt?: string;
  message: string;
  channelId: string;
  platform: 'discord' | 'slack';
  createdAt: string;
  enabled: boolean;
  label?: string;
}

function getScheduleFilePath(): string {
  const dataDir = process.env.DATA_DIR || join(process.cwd(), '.xangi');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  return join(dataDir, 'schedules.json');
}

function loadSchedules(): Schedule[] {
  const filePath = getScheduleFilePath();
  if (!existsSync(filePath)) return [];
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Schedule[];
  } catch {
    return [];
  }
}

function saveSchedules(schedules: Schedule[]): void {
  const filePath = getScheduleFilePath();
  writeFileSync(filePath, JSON.stringify(schedules, null, 2));
}

function generateId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

async function scheduleList(): Promise<string> {
  const schedules = loadSchedules();
  if (schedules.length === 0) {
    return '📋 没有日程';
  }
  return formatScheduleList(schedules);
}

async function scheduleAdd(flags: Record<string, string>): Promise<string> {
  const input = flags['input'];
  const channelId = flags['channel'];
  const platform = (flags['platform'] || 'discord') as 'discord' | 'slack';

  if (!input) throw new Error('--input 是必需的');
  if (!channelId) throw new Error('--channel 是必需的');

  const parsed = parseScheduleInput(input);
  if (!parsed) {
    throw new Error(`无法解析日程格式: ${input}`);
  }

  const schedules = loadSchedules();
  // 如果指定了 targetChannelId，则优先使用
  const targetChannel = parsed.targetChannelId || channelId;

  const newSchedule: Schedule = {
    id: generateId(),
    type: parsed.type,
    expression: parsed.expression,
    runAt: parsed.runAt,
    message: parsed.message,
    channelId: targetChannel,
    platform,
    createdAt: new Date().toISOString(),
    enabled: true,
  };
  schedules.push(newSchedule);
  saveSchedules(schedules);

  return `✅ 已添加日程 (ID: ${newSchedule.id})`;
}

async function scheduleRemove(flags: Record<string, string>): Promise<string> {
  const id = flags['id'];
  if (!id) throw new Error('--id 是必需的');

  const schedules = loadSchedules();
  const index = schedules.findIndex((s) => s.id === id);
  if (index === -1) {
    return `❌ 未找到日程: ${id}`;
  }

  schedules.splice(index, 1);
  saveSchedules(schedules);

  return `🗑️ 已删除日程: ${id}`;
}

async function scheduleToggle(flags: Record<string, string>): Promise<string> {
  const id = flags['id'];
  if (!id) throw new Error('--id 是必需的');

  const schedules = loadSchedules();
  const schedule = schedules.find((s) => s.id === id);
  if (!schedule) {
    return `❌ 未找到日程: ${id}`;
  }

  schedule.enabled = !schedule.enabled;
  saveSchedules(schedules);

  return `🔄 日程 ${id}: 已切换为 ${schedule.enabled ? '启用' : '禁用'}`;
}

// ─── 路由器 ─────────────────────────────────────────────────────────

export async function scheduleCmd(command: string, flags: Record<string, string>): Promise<string> {
  switch (command) {
    case 'schedule_list':
      return scheduleList();
    case 'schedule_add':
      return scheduleAdd(flags);
    case 'schedule_remove':
      return scheduleRemove(flags);
    case 'schedule_toggle':
      return scheduleToggle(flags);
    default:
      throw new Error(`未知的日程命令: ${command}`);
  }
}
