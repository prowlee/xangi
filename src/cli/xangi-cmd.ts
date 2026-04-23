#!/usr/bin/env node
/**
 * xangi-cmd — xangi 命令的 CLI 接口
 *
 * 直接调用 Discord REST API 执行 Discord 操作。
 * 通过 Bash 被 Claude Code 调用，通过 exec 工具被本地 LLM 调用。
 *
 * 环境变量:
 *   XANGI_DIR — xangi-dev 的目录（.env 的加载来源）
 *   DISCORD_TOKEN — Discord BOT 令牌（从 .env 自动加载）
 *
 * 用法:
 *   node xangi-cmd.js discord_history --channel <id> [--count <n>] [--offset <n>]
 *   node xangi-cmd.js discord_send --channel <id> --message <text>
 *   node xangi-cmd.js discord_channels --guild <id>
 *   node xangi-cmd.js discord_search --channel <id> --keyword <text>
 *   node xangi-cmd.js discord_edit --channel <id> --message-id <id> --content <text>
 *   node xangi-cmd.js discord_delete --channel <id> --message-id <id>
 *   node xangi-cmd.js schedule_list
 *   node xangi-cmd.js schedule_add --input <text> --channel <id> --platform <discord|slack>
 *   node xangi-cmd.js schedule_remove --id <id>
 *   node xangi-cmd.js schedule_toggle --id <id>
 *   node xangi-cmd.js media_send --channel <id> --file <path>
 *   node xangi-cmd.js system_restart
 *   node xangi-cmd.js system_settings --key <key> --value <value>
 */
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { discordApi } from './discord-api.js';
import { scheduleCmd } from './schedule-cmd.js';
import { systemCmd } from './system-cmd.js';

// 自动加载 .env 文件（获取 DISCORD_TOKEN 等密钥）
function loadEnvFile(): void {
  // 1. 从 XANGI_DIR 读取 .env
  // 2. 如果没有，则从自身 dist/cli/ 向上两级（xangi-dev/）读取 .env
  const candidates: string[] = [];

  if (process.env.XANGI_DIR) {
    candidates.push(join(process.env.XANGI_DIR, '.env'));
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  candidates.push(join(__dirname, '..', '..', '.env'));

  for (const envPath of candidates) {
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        // 去除引号
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        // 如果尚未设置，则设置
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
      break;
    }
  }
}

loadEnvFile();

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const command = argv[2] || '';
  const flags: Record<string, string> = {};
  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      flags[key] = value;
    }
  }
  return { command, flags };
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv);

  if (!command || command === 'help') {
    console.log(`xangi-cmd — xangi 命令 CLI

Discord 操作:
  discord_history   获取频道历史记录
  discord_send      发送消息
  discord_channels  频道列表
  discord_search    搜索消息
  discord_edit      编辑消息
  discord_delete    删除消息

日程:
  schedule_list     显示列表
  schedule_add      添加
  schedule_remove   删除
  schedule_toggle   启用/禁用切换

其他:
  media_send        发送文件
  system_restart    重启
  system_settings   更改设置`);
    return;
  }

  try {
    let result: string;

    if (command.startsWith('discord_')) {
      result = await discordApi(command, flags);
    } else if (command.startsWith('schedule_')) {
      result = await scheduleCmd(command, flags);
    } else if (command === 'media_send') {
      result = await discordApi(command, flags);
    } else if (command.startsWith('system_')) {
      result = await systemCmd(command, flags);
    } else {
      console.error(`未知命令: ${command}`);
      process.exit(1);
    }

    console.log(result);
  } catch (err) {
    console.error(`错误: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
