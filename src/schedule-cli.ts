#!/usr/bin/env node
/**
 * 调度器 CLI - 供 Agent（Claude Code / Codex）调用使用
 *
 * 用法:
 *   schedule-cli add --channel <id> --platform <discord|slack> "30分钟后 消息"
 *   schedule-cli add --channel <id> --platform <discord|slack> --cron "0 9 * * *" --message "早上好"
 *   schedule-cli list [--channel <id>] [--platform <discord|slack>]
 *   schedule-cli remove <id>
 *   schedule-cli toggle <id>
 */

import {
  Scheduler,
  parseScheduleInput,
  formatScheduleList,
  SCHEDULE_SEPARATOR,
  type Platform,
} from './scheduler.js';

const DATA_DIR = process.env.DATA_DIR || undefined;
const schedulerConfig = {
  enabled: process.env.SCHEDULER_ENABLED !== 'false',
  startupEnabled: process.env.STARTUP_ENABLED !== 'false',
};

function usage(): void {
  console.log(`调度器 CLI

用法:
  schedule-cli add --channel <id> --platform <discord|slack> "<输入>"
  schedule-cli add --channel <id> --platform <discord|slack> --cron "<cron表达式>" --message "<消息>"
  schedule-cli add --channel <id> --platform <discord|slack> --at "<ISO日期时间>" --message "<消息>"
  schedule-cli list [--channel <id>] [--platform <discord|slack>]
  schedule-cli remove <id>
  schedule-cli toggle <id>

自然语言输入示例:
  "30分钟后 会议开始"
  "15:00 代码审查"
  "每天 9:00 早上好"
  "每周一 10:00 周会"

环境变量:
  XANGI_DATA_DIR or DATA_DIR  数据目录（默认: ./.xangi）
`);
}

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
      result[key] = val;
    } else {
      positional.push(args[i]);
    }
  }

  if (positional.length > 0) result['_command'] = positional[0];
  if (positional.length > 1) result['_arg'] = positional.slice(1).join(' ');

  return result;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const command = args['_command'];

  if (!command || command === 'help' || args['help']) {
    usage();
    process.exit(0);
  }

  const scheduler = new Scheduler(DATA_DIR, { quiet: true });

  switch (command) {
    case 'add': {
      const channel = args['channel'];
      const platform = (args['platform'] || 'discord') as Platform;

      if (!channel) {
        console.error('错误: --channel 是必需的');
        process.exit(1);
      }

      // 直接指定 cron 表达式
      if (args['cron'] && args['message']) {
        try {
          const schedule = scheduler.add({
            type: 'cron',
            expression: args['cron'],
            message: args['message'],
            channelId: channel,
            platform,
            label: args['label'],
          });
          console.log(JSON.stringify({ ok: true, schedule }, null, 2));
        } catch (error) {
          console.error(
            JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
          );
          process.exit(1);
        }
        break;
      }

      // 直接指定日期时间
      if (args['at'] && args['message']) {
        try {
          const schedule = scheduler.add({
            type: 'once',
            runAt: new Date(args['at']).toISOString(),
            message: args['message'],
            channelId: channel,
            platform,
            label: args['label'],
          });
          console.log(JSON.stringify({ ok: true, schedule }, null, 2));
        } catch (error) {
          console.error(
            JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
          );
          process.exit(1);
        }
        break;
      }

      // 自然语言解析
      const input = args['_arg'];
      if (!input) {
        console.error('错误: 输入文本是必需的');
        console.error('用法: schedule-cli add --channel <id> "30分钟后 消息"');
        process.exit(1);
      }

      const parsed = parseScheduleInput(input);
      if (!parsed) {
        console.error(
          JSON.stringify({
            ok: false,
            error: `无法解析输入: "${input}"`,
            hint: '支持: "N分钟后 msg", "HH:MM msg", "每天 HH:MM msg", "每周X HH:MM msg"',
          })
        );
        process.exit(1);
      }

      try {
        const schedule = scheduler.add({
          ...parsed,
          channelId: channel,
          platform,
          label: args['label'],
        });
        console.log(JSON.stringify({ ok: true, schedule }, null, 2));
      } catch (error) {
        console.error(
          JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        );
        process.exit(1);
      }
      break;
    }

    case 'list': {
      const channel = args['channel'];
      const platform = args['platform'] as Platform | undefined;
      const schedules = scheduler.list(channel, platform);

      if (args['json'] === 'true') {
        console.log(JSON.stringify({ ok: true, schedules }, null, 2));
      } else {
        console.log(
          formatScheduleList(schedules, schedulerConfig).replaceAll(SCHEDULE_SEPARATOR, '')
        );
      }
      break;
    }

    case 'remove':
    case 'delete':
    case 'rm': {
      const idOrIndexList = args['_arg'];
      if (!idOrIndexList) {
        console.error('错误: 需要调度器 ID 或序号');
        process.exit(1);
      }

      const parts = idOrIndexList.trim().split(/\s+/).filter(Boolean);
      const channel = args['channel'];
      const platform = args['platform'] as Platform | undefined;
      const schedules = scheduler.list(channel, platform);
      const deletedIds: string[] = [];
      const errors: string[] = [];

      // 将序号按降序排序（防止删除时的索引偏移）
      const targets = parts
        .map((p) => {
          const num = parseInt(p, 10);
          if (!isNaN(num) && num > 0 && !p.startsWith('sch_')) {
            if (num > schedules.length) {
              errors.push(`序号 ${num} 超出范围`);
              return null;
            }
            return { index: num, id: schedules[num - 1].id };
          }
          return { index: 0, id: p };
        })
        .filter((t): t is { index: number; id: string } => t !== null)
        .sort((a, b) => b.index - a.index);

      for (const target of targets) {
        if (scheduler.remove(target.id)) {
          deletedIds.push(target.id);
        } else {
          errors.push(`未找到 ID ${target.id}`);
        }
      }

      if (deletedIds.length === 0) {
        console.error(
          JSON.stringify({ ok: false, error: errors.join(', ') || '未删除任何调度任务' })
        );
        process.exit(1);
      }

      // 删除成功后，显示剩余的调度任务列表
      const remaining = scheduler.list(channel, platform);
      console.log(`✅ 已删除 ${deletedIds.length} 项\n`);
      console.log(
        formatScheduleList(remaining, schedulerConfig).replaceAll(SCHEDULE_SEPARATOR, '')
      );
      break;
    }

    case 'toggle': {
      const idOrIndex = args['_arg'];
      if (!idOrIndex) {
        console.error('错误: 需要调度器 ID 或序号');
        process.exit(1);
      }

      let targetId = idOrIndex.trim();

      // 如果指定的是序号，获取对应的 ID
      const indexNum = parseInt(targetId, 10);
      if (!isNaN(indexNum) && indexNum > 0 && !targetId.startsWith('sch_')) {
        const channel = args['channel'];
        const platform = args['platform'] as Platform | undefined;
        const schedules = scheduler.list(channel, platform);
        if (indexNum > schedules.length) {
          console.error(
            JSON.stringify({
              ok: false,
              error: `序号 ${indexNum} 超出范围（1〜${schedules.length}）`,
            })
          );
          process.exit(1);
        }
        targetId = schedules[indexNum - 1].id;
      }

      const schedule = scheduler.toggle(targetId);
      if (!schedule) {
        console.error(JSON.stringify({ ok: false, error: `未找到 ID: ${targetId}` }));
        process.exit(1);
      }

      // 清晰显示切换结果
      const status = schedule.enabled ? '✅ 已启用' : '⏸️ 已禁用';
      console.log(`${status}: ${targetId}\n`);

      // 显示当前列表
      const channel = args['channel'];
      const platform = args['platform'] as Platform | undefined;
      const all = scheduler.list(channel, platform);
      console.log(formatScheduleList(all, schedulerConfig).replaceAll(SCHEDULE_SEPARATOR, ''));
      break;
    }

    default:
      console.error(`未知命令: ${command}`);
      usage();
      process.exit(1);
  }

  // CLI 立即退出（不启动 cron 任务）
  scheduler.stopAll();
}

main();
