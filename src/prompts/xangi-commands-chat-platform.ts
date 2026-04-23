/**
 * 聊天平台（Discord/Slack）通用命令
 *
 * 文本解析：MEDIA:，=== 分隔符
 * CLI 工具：日程、系统命令
 */
export const XANGI_COMMANDS_CHAT_PLATFORM = `## 文件发送

要向聊天发送文件，请在输出中包含以下格式的路径（**不一定要在行首**，文本中间也能识别）：

\`\`\`
MEDIA:/path/to/file
\`\`\`

**支持的格式:** png, jpg, jpeg, gif, webp, mp3, mp4, wav, flac, pdf, zip

用户上传的附件将以 \`[附件]\` 的形式传递路径。

## 消息分割分隔符

在响应文本中加入 \`\\n===\\n\`（前后包含换行符的 \`===\`），将从该位置分割并作为单独的消息发送。
当一次响应需要发送多条独立消息时使用（如 content-digest 等）。

## 日程・提醒

\`\`\`bash
xangi-cmd schedule_list
xangi-cmd schedule_add --input "每天 9:00 早上好" --channel <频道ID>
xangi-cmd schedule_add --input "30分钟后 开会" --channel <频道ID>
xangi-cmd schedule_add --input "15:00 代码审查" --channel <频道ID>
xangi-cmd schedule_add --input "每周一 10:00 周会" --channel <频道ID>
xangi-cmd schedule_add --input "cron 0 9 * * * 早上好" --channel <频道ID>
xangi-cmd schedule_remove --id <日程ID>
xangi-cmd schedule_toggle --id <日程ID>
\`\`\`

## 系统命令

\`\`\`bash
xangi-cmd system_restart
xangi-cmd system_settings --key autoRestart --value true
xangi-cmd system_settings  # 查看设置列表
\`\`\``;
