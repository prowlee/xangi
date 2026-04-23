import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  watchFile,
  unwatchFile,
  renameSync,
  unlinkSync,
} from 'fs';
import { dirname, join } from 'path';
import cron from 'node-cron';
/** 调度列表项之间的分隔符（用于 splitMessage） */
export const SCHEDULE_SEPARATOR = '{{SPLIT}}';

// ─── 类型定义 ───────────────────────────────────────────────────────────
export type ScheduleType = 'cron' | 'once' | 'startup';
export type Platform = 'discord' | 'slack';
export interface Schedule {
  id: string;
  type: ScheduleType;
  /** cron 表达式（type='cron' 时）*/
  expression?: string;
  /** 执行时间 ISO8601（type='once' 时）*/
  runAt?: string;
  /** 发送的消息或给 Agent 的提示词 */
  message: string;
  /** 目标频道 ID */
  channelId: string;
  /** 平台 */
  platform: Platform;
  /** 创建时间 ISO8601 */
  createdAt: string;
  /** 启用/禁用 */
  enabled: boolean;
  /** 标签（可选）*/
  label?: string;
}
export interface SendMessageFn {
  (channelId: string, message: string): Promise<void>;
}
export interface AgentRunFn {
  (prompt: string, channelId: string): Promise<string>;
}
// ─── 调度器 ───────────────────────────────────────────────────────
export class Scheduler {
  private schedules: Schedule[] = [];
  private cronJobs = new Map<string, cron.ScheduledTask>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private filePath: string;
  private senders = new Map<Platform, SendMessageFn>();
  private agentRunners = new Map<Platform, AgentRunFn>();
  private watching = false;
  private lastSaveTime = 0;
  private lastReloadTime = 0;
  private quiet: boolean;
  private disabled = false;
  constructor(dataDir?: string, options?: { quiet?: boolean }) {
    this.quiet = options?.quiet ?? false;
    const dir = dataDir || join(process.cwd(), '.xangi');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.filePath = join(dir, 'schedules.json');
    this.load();
  }
  private log(message: string): void {
    if (!this.quiet) {
      console.log(message);
    }
  }
  // ─── 发送器注册 ──────────────────────────────────────────
  /**
   * 注册平台的消息发送函数
   */
  registerSender(platform: Platform, sender: SendMessageFn): void {
    this.senders.set(platform, sender);
  }
  /**
   * 注册平台的 Agent 执行函数
   */
  registerAgentRunner(platform: Platform, runner: AgentRunFn): void {
    this.agentRunners.set(platform, runner);
  }
  // ─── CRUD 操作 ─────────────────────────────────────────────────────────
  /**
   * 添加调度任务
   */
  add(schedule: Omit<Schedule, 'id' | 'createdAt' | 'enabled'>): Schedule {
    // 验证
    if (schedule.type === 'cron') {
      if (!schedule.expression || !cron.validate(schedule.expression)) {
        throw new Error(
          `无效的 cron 表达式: ${schedule.expression}\n` +
            '示例: "0 9 * * *"（每天9点）, "*/30 * * * *"（每30分钟）'
        );
      }
    } else if (schedule.type === 'once') {
      if (!schedule.runAt) {
        throw new Error('一次性调度任务需要 runAt 参数');
      }
      const runTime = new Date(schedule.runAt).getTime();
      if (isNaN(runTime)) {
        throw new Error(`无效的日期: ${schedule.runAt}`);
      }
      if (runTime <= Date.now()) {
        throw new Error('runAt 必须是未来的时间');
      }
    } else if (schedule.type === 'startup') {
      // startup 类型无需额外验证
    } else {
      throw new Error(`未知的调度类型: ${schedule.type}`);
    }
    const newSchedule: Schedule = {
      ...schedule,
      id: this.generateId(),
      createdAt: new Date().toISOString(),
      enabled: true,
    };
    this.schedules.push(newSchedule);
    this.save();
    if (!this.disabled) {
      this.startJob(newSchedule);
    }
    return newSchedule;
  }
  /**
   * 删除调度任务
   */
  remove(id: string): boolean {
    const index = this.schedules.findIndex((s) => s.id === id);
    if (index === -1) return false;
    this.stopJob(id);
    this.schedules.splice(index, 1);
    this.save();
    return true;
  }
  /**
   * 获取调度任务列表
   */
  list(channelId?: string, platform?: Platform): Schedule[] {
    let result = this.schedules;
    if (channelId) {
      result = result.filter((s) => s.channelId === channelId);
    }
    if (platform) {
      result = result.filter((s) => s.platform === platform);
    }
    return result;
  }
  /**
   * 获取单个调度任务
   */
  get(id: string): Schedule | undefined {
    return this.schedules.find((s) => s.id === id);
  }
  /**
   * 切换调度任务的启用/禁用状态
   */
  toggle(id: string): Schedule | undefined {
    const schedule = this.schedules.find((s) => s.id === id);
    if (!schedule) return undefined;
    schedule.enabled = !schedule.enabled;
    this.save();
    if (!this.disabled) {
      if (schedule.enabled) {
        this.startJob(schedule);
      } else {
        this.stopJob(id);
      }
    }
    return schedule;
  }
  // ─── 任务管理 ───────────────────────────────────────────────
  /**
   * 启动所有调度任务（启动时调用）
   */
  startAll(options?: { enabled?: boolean; startupEnabled?: boolean }): void {
    const schedulerEnabled = options?.enabled ?? true;
    const startupEnabled = options?.startupEnabled ?? true;

    if (!schedulerEnabled) {
      this.disabled = true;
      this.log('[scheduler] 调度器已禁用 (SCHEDULER_ENABLED=false)，跳过所有任务');
      this.startWatching();
      return;
    }

    const startupTasks: Schedule[] = [];
    for (const schedule of this.schedules) {
      if (schedule.enabled) {
        if (schedule.type === 'startup') {
          startupTasks.push(schedule);
        } else {
          this.startJob(schedule);
        }
      }
    }
    this.startWatching();
    const regularJobs = this.schedules.filter((s) => s.enabled && s.type !== 'startup').length;
    this.log(`[scheduler] 已启动 ${regularJobs} 个定时任务，${startupTasks.length} 个启动任务`);

    if (!startupEnabled) {
      this.log('[scheduler] 启动任务已禁用 (STARTUP_ENABLED=false)，跳过');
      return;
    }

    // 执行启动任务
    for (const task of startupTasks) {
      this.log(`[scheduler] 执行启动任务: ${task.id}`);
      this.executeJob(task).catch((err) => {
        console.error(`[scheduler] 启动任务失败: ${task.id}`, err);
      });
    }
  }
  /**
   * 停止所有任务（关闭时调用）
   */
  stopAll(): void {
    this.stopWatching();
    for (const [id] of this.cronJobs) {
      this.stopJob(id);
    }
    for (const [id] of this.timers) {
      this.stopJob(id);
    }
  }
  // ─── 文件监听 ────────────────────────────────────────────────
  /**
   * 监听文件变化并自动重新加载（检测来自 CLI 等的外部修改）
   */
  private startWatching(): void {
    if (this.watching) return;
    this.watching = true;
    watchFile(this.filePath, { interval: 2000 }, () => {
      const now = Date.now();
      // 忽略自身保存导致的修改（2秒内）
      if (now - this.lastSaveTime < 2000) return;
      // 防止连续事件触发（防抖：1秒内的重复事件忽略）
      if (now - this.lastReloadTime < 1000) return;
      this.lastReloadTime = now;
      this.log('[scheduler] 检测到文件变化，正在重新加载...');
      this.reload();
    });
  }
  private stopWatching(): void {
    if (!this.watching) return;
    unwatchFile(this.filePath);
    this.watching = false;
  }
  /**
   * 从文件重新加载并重启任务
   */
  private reload(): void {
    // 停止所有现有任务
    for (const [id] of this.cronJobs) {
      this.stopJob(id);
    }
    for (const [id] of this.timers) {
      this.stopJob(id);
    }
    // 重新加载
    this.load();
    // 重启启用的任务（调度器禁用时跳过）
    if (!this.disabled) {
      for (const schedule of this.schedules) {
        if (schedule.enabled) {
          this.startJob(schedule);
        }
      }
    }
    this.log(`[scheduler] 已重新加载: ${this.schedules.filter((s) => s.enabled).length} 个活跃任务`);
  }
  private startJob(schedule: Schedule): void {
    // 如果已在运行，先停止
    this.stopJob(schedule.id);
    if (schedule.type === 'cron' && schedule.expression) {
      const task = cron.schedule(
        schedule.expression,
        () => {
          this.executeJob(schedule);
        },
        { timezone: 'Asia/Tokyo' }
      );
      this.cronJobs.set(schedule.id, task);
      this.log(
        `[scheduler] Cron 任务已启动: ${schedule.id} (${schedule.expression}) → ${schedule.channelId}`
      );
    } else if (schedule.type === 'once' && schedule.runAt) {
      const delay = new Date(schedule.runAt).getTime() - Date.now();
      if (delay <= 0) {
        // 已过期 → 立即执行并删除
        this.log(`[scheduler] 一次性任务 ${schedule.id} 已过期，立即执行`);
        this.executeJob(schedule);
        this.remove(schedule.id);
        return;
      }
      const timer = setTimeout(() => {
        this.executeJob(schedule);
        // 一次性任务执行后删除
        this.remove(schedule.id);
      }, delay);
      this.timers.set(schedule.id, timer);
      const runDate = new Date(schedule.runAt);
      this.log(
        `[scheduler] 定时器已设置: ${schedule.id} → ${runDate.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} (${Math.round(delay / 1000)}秒)`
      );
    }
  }
  private stopJob(id: string): void {
    const cronJob = this.cronJobs.get(id);
    if (cronJob) {
      cronJob.stop();
      this.cronJobs.delete(id);
    }
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }
  private async executeJob(schedule: Schedule): Promise<void> {
    // 始终使用 agent 模式执行
    const agentRunner = this.agentRunners.get(schedule.platform);
    if (!agentRunner) {
      // 没有 agentRunner 时的回退方案
      const sender = this.senders.get(schedule.platform);
      if (sender) {
        const prefix = schedule.label ? `⏰ **${schedule.label}**\n` : '⏰ ';
        await sender(schedule.channelId, `${prefix}${schedule.message}`);
        this.log(`[scheduler] 已执行（回退）: ${schedule.id} → ${schedule.channelId}`);
      } else {
        console.error(`[scheduler] 平台 ${schedule.platform} 没有运行器/发送器`);
      }
      return;
    }
    try {
      this.log(`[scheduler] 正在为 ${schedule.id} 运行 Agent`);
      const result = await agentRunner(schedule.message, schedule.channelId);
      this.log(`[scheduler] Agent 执行完成: ${schedule.id} (${result.length} 字符)`);
    } catch (error) {
      console.error(`[scheduler] 执行 ${schedule.id} 失败:`, error);
    }
  }
  // ─── 持久化 ──────────────────────────────────────────────────
  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8');
        this.schedules = JSON.parse(raw);
        this.log(`[scheduler] 从 ${this.filePath} 加载了 ${this.schedules.length} 个调度任务`);
      }
    } catch (error) {
      console.error('[scheduler] 加载调度任务失败:', error);
      this.schedules = [];
    }
  }
  private save(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      this.lastSaveTime = Date.now();
      // 原子写入：临时文件 → 重命名
      const tmpPath = `${this.filePath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(this.schedules, null, 2), 'utf-8');
      renameSync(tmpPath, this.filePath);
    } catch (error) {
      console.error('[scheduler] 保存调度任务失败:', error);
      // 如果临时文件残留，则删除
      const tmpPath = `${this.filePath}.tmp`;
      try {
        if (existsSync(tmpPath)) {
          unlinkSync(tmpPath);
        }
      } catch {
        // 清理失败忽略
      }
    }
  }
  private generateId(): string {
    return `sch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }
}
// ─── 格式化器 ───────────────────────────────────────────────────────
/**
 * 格式化调度任务列表
 */
export function formatScheduleList(
  schedules: Schedule[],
  options?: { enabled?: boolean; startupEnabled?: boolean }
): string {
  const schedulerEnabled = options?.enabled ?? true;
  const startupEnabled = options?.startupEnabled ?? true;

  const statusHeader: string[] = [];
  if (!schedulerEnabled) {
    statusHeader.push('⚠️ **调度器已禁用** (`SCHEDULER_ENABLED=false`)');
  }
  if (!startupEnabled) {
    statusHeader.push('⚠️ **启动任务已禁用** (`STARTUP_ENABLED=false`)');
  }

  if (schedules.length === 0) {
    const header = statusHeader.length > 0 ? statusHeader.join('\n') + '\n\n' : '';
    return header + '📋 没有调度任务';
  }

  // 分离普通调度任务和启动任务
  const regularSchedules = schedules.filter((s) => s.type !== 'startup');
  const startupTasks = schedules.filter((s) => s.type === 'startup');

  const formatItem = (s: Schedule, i: number): string => {
    const status = s.enabled ? '✅' : '⏸️';
    const label = s.label ? ` [${s.label}]` : '';
    const channelMention = `<#${s.channelId}>`;

    if (s.type === 'cron' && s.expression) {
      const humanReadable = cronToHuman(s.expression);
      return (
        `**${i + 1}.** ${status} 📅 ${humanReadable}${label}\n` +
        `└ 📝 ${s.message}\n` +
        `└ 📢 ${channelMention}\n` +
        `└ 🔄 \`${s.expression}\`\n` +
        `└ 🆔 \`${s.id}\``
      );
    } else if (s.type === 'startup') {
      return (
        `**${i + 1}.** ${status} 🚀 启动时执行${label}\n` +
        `└ 📝 ${s.message}\n` +
        `└ 📢 ${channelMention}\n` +
        `└ 🆔 \`${s.id}\``
      );
    } else {
      // once（一次性）
      return (
        `**${i + 1}.** ${status} ⏰ ${formatTime(s.runAt!)}${label}\n` +
        `└ 📝 ${s.message}\n` +
        `└ 📢 ${channelMention}\n` +
        `└ 🆔 \`${s.id}\``
      );
    }
  };

  const sections: string[] = [];

  if (regularSchedules.length > 0) {
    const lines = regularSchedules.map((s, i) => formatItem(s, i));
    sections.push(
      `📋 **调度任务列表** (${regularSchedules.length}项)\n\n${lines.join('\n' + SCHEDULE_SEPARATOR + '\n')}`
    );
  }

  if (startupTasks.length > 0) {
    const lines = startupTasks.map((s, i) => formatItem(s, i));
    sections.push(
      `🚀 **启动任务** (${startupTasks.length}项)\n\n${lines.join('\n' + SCHEDULE_SEPARATOR + '\n')}`
    );
  }

  const header = statusHeader.length > 0 ? statusHeader.join('\n') + '\n\n' : '';
  return header + sections.join('\n' + SCHEDULE_SEPARATOR + '\n') + '\n';
}
function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}
/**
 * 将 cron 表达式转换为人类可读的格式
 * @param expression cron 表达式 (分 时 日 月 星期)
 */
function cronToHuman(expression: string): string {
  const parts = expression.split(/\s+/);
  if (parts.length !== 5) return expression;
  const [min, hour, dayOfMonth, month, dayOfWeek] = parts;
  // 星期映射
  const dayNames: Record<string, string> = {
    '0': '日',
    '1': '一',
    '2': '二',
    '3': '三',
    '4': '四',
    '5': '五',
    '6': '六',
    '7': '日',
  };
  // 格式化时间
  const formatHourMin = (h: string, m: string): string => {
    if (h === '*' && m === '*') return '';
    if (h === '*') return `每小时 ${m}分`;
    if (m === '*') return `${h}点`;
    return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  };
  // 每N分钟/每N小时
  const intervalMatch = min.match(/^\*\/(\d+)$/);
  if (intervalMatch && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `每${intervalMatch[1]}分钟`;
  }
  const hourIntervalMatch = hour.match(/^\*\/(\d+)$/);
  if (
    hourIntervalMatch &&
    min !== '*' &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    return `每${hourIntervalMatch[1]}小时 (${min}分)`;
  }
  // 每小时
  if (hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return min === '0' ? '每小时' : `每小时 ${min}分`;
  }
  // 每天
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `每天 ${formatHourMin(hour, min)}`;
  }
  // 特定星期
  if (dayOfMonth === '*' && month === '*' && dayOfWeek !== '*') {
    // 范围格式 (1-5 = 周一至周五)
    const rangeMatch = dayOfWeek.match(/^(\d)-(\d)$/);
    if (rangeMatch) {
      const start = dayNames[rangeMatch[1]] || rangeMatch[1];
      const end = dayNames[rangeMatch[2]] || rangeMatch[2];
      if (start === '一' && end === '五') {
        return `工作日 ${formatHourMin(hour, min)}`;
      }
      return `${start}至${end} ${formatHourMin(hour, min)}`;
    }
    // 单个星期
    const dayName = dayNames[dayOfWeek] || dayOfWeek;
    return `每周${dayName} ${formatHourMin(hour, min)}`;
  }
  // 特定日期
  if (dayOfMonth !== '*' && month === '*' && dayOfWeek === '*') {
    return `每月${dayOfMonth}日 ${formatHourMin(hour, min)}`;
  }
  // 其他情况：原样返回
  return expression;
}
// ─── 解析器 ──────────────────────────────────────────────────────────
/**
 * 将自然语言风格的输入解析为调度参数
 *
 * 支持的格式:
 * - "30分钟后 开始会议" → once, 30分钟后
 * - "1小时后 休息一下" → once, 1小时后
 * - "15:00 代码审查" → once, 今天15:00（如果已过则为明天）
 * - "每天 9:00 早上好" → cron, 0 9 * * *
 * - "每小时 检查" → cron, 0 * * * *
 * - "cron 0 9 * * * 早上好" → cron, 直接指定
 */
export function parseScheduleInput(input: string): {
  type: ScheduleType;
  expression?: string;
  runAt?: string;
  message: string;
  targetChannelId?: string;
} | null {
  let trimmed = input.trim();
  // 提取 -c <#channelId> 或 --channel <#channelId> 选项
  let targetChannelId: string | undefined;
  const channelOptMatch = trimmed.match(/(?:^|\s)(?:-c|--channel)\s+<#(\d+)>(?:\s|$)/);
  if (channelOptMatch) {
    targetChannelId = channelOptMatch[1];
    trimmed = trimmed.replace(channelOptMatch[0], ' ').trim();
  }
  // 也支持 <#channelId> 开头的格式
  const channelPrefixMatch = trimmed.match(/^<#(\d+)>\s+/);
  if (!targetChannelId && channelPrefixMatch) {
    targetChannelId = channelPrefixMatch[1];
    trimmed = trimmed.replace(channelPrefixMatch[0], '').trim();
  }
  // cron 表达式直接指定: "cron 0 9 * * * 消息"
  const cronMatch = trimmed.match(/^cron\s+((?:\S+\s+){4}\S+)\s+(.+)$/i);
  if (cronMatch) {
    return {
      type: 'cron',
      expression: cronMatch[1].trim(),
      message: cronMatch[2].trim(),
      targetChannelId,
    };
  }
  // "每天 HH:MM 消息"
  const dailyMatch = trimmed.match(/^每天\s+(\d{1,2}):(\d{2})\s+(.+)$/);
  if (dailyMatch) {
    const hour = parseInt(dailyMatch[1], 10);
    const min = parseInt(dailyMatch[2], 10);
    return {
      type: 'cron',
      expression: `${min} ${hour} * * *`,
      message: dailyMatch[3].trim(),
      targetChannelId,
    };
  }
  // "每小时 消息" or "每小时 MM分 消息"
  const hourlyMatch = trimmed.match(/^每小时\s+(?:(\d{1,2})分\s+)?(.+)$/);
  if (hourlyMatch) {
    const min = hourlyMatch[1] ? parseInt(hourlyMatch[1], 10) : 0;
    return {
      type: 'cron',
      expression: `${min} * * * *`,
      message: hourlyMatch[2].trim(),
      targetChannelId,
    };
  }
  // "每周一 HH:MM 消息" (支持星期)
  const weeklyMatch = trimmed.match(/^每周(一|二|三|四|五|六|日)??\s+(\d{1,2}):(\d{2})\s+(.+)$/);
  if (weeklyMatch) {
    const dayMap: Record<string, number> = {
      日: 0,
      一: 1,
      二: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
    };
    const day = dayMap[weeklyMatch[1]] ?? 1;
    const hour = parseInt(weeklyMatch[2], 10);
    const min = parseInt(weeklyMatch[3], 10);
    return {
      type: 'cron',
      expression: `${min} ${hour} * * ${day}`,
      message: weeklyMatch[4].trim(),
      targetChannelId,
    };
  }
  // "N分钟后 消息" or "N小时后 消息"
  const relativeMatch = trimmed.match(/^(\d+)\s*(分|小时|秒)后?\s+(.+)$/);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2];
    let ms: number;
    switch (unit) {
      case '秒':
        ms = amount * 1000;
        break;
      case '分':
        ms = amount * 60 * 1000;
        break;
      case '小时':
        ms = amount * 60 * 60 * 1000;
        break;
      default:
        return null;
    }
    return {
      type: 'once',
      runAt: new Date(Date.now() + ms).toISOString(),
      message: relativeMatch[3].trim(),
      targetChannelId,
    };
  }
  // "HH:MM 消息" → 今天的该时刻（如果已过则为明天）
  const timeMatch = trimmed.match(/^(\d{1,2}):(\d{2})\s+(.+)$/);
  if (timeMatch) {
    const hour = parseInt(timeMatch[1], 10);
    const min = parseInt(timeMatch[2], 10);
    const now = new Date();
    // 以 Asia/Tokyo 时区设置
    const jstOffset = 9 * 60; // JST = UTC+9
    const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const jstMinutes = utcMinutes + jstOffset;
    const targetMinutes = hour * 60 + min;
    // 基于 JST 判断今天还是明天
    const currentJstMinutes = jstMinutes % (24 * 60);
    let diffMinutes = targetMinutes - currentJstMinutes;
    if (diffMinutes <= 0) {
      diffMinutes += 24 * 60; // 明天
    }
    const runAt = new Date(now.getTime() + diffMinutes * 60 * 1000);
    return {
      type: 'once',
      runAt: runAt.toISOString(),
      message: timeMatch[3].trim(),
      targetChannelId,
    };
  }
  // "YYYY-MM-DD HH:MM 消息"
  const dateTimeMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s+(.+)$/);
  if (dateTimeMatch) {
    const dateStr = dateTimeMatch[1];
    const hour = parseInt(dateTimeMatch[2], 10);
    const min = parseInt(dateTimeMatch[3], 10);
    // 解释为 JST 时区
    const runAt = new Date(
      `${dateStr}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00+09:00`
    );
    return {
      type: 'once',
      runAt: runAt.toISOString(),
      message: dateTimeMatch[4].trim(),
      targetChannelId,
    };
  }
  // "启动时 消息" or "startup 消息"
  const startupMatch = trimmed.match(/^(?:启动时|startup)\s+(.+)$/i);
  if (startupMatch) {
    return {
      type: 'startup',
      message: startupMatch[1].trim(),
      targetChannelId,
    };
  }
  return null;
}
