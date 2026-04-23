/**
 * Discord 操作命令（xangi-cmd CLI 工具版）
 *
 * 仅限 Discord 特有的操作。日程、系统操作请使用聊天平台通用命令。
 */
export const XANGI_COMMANDS_DISCORD = `## Discord 操作

Discord 操作通过 **Bash 工具执行 \`xangi-cmd\`** 来完成。

### 获取频道历史记录

\`\`\`bash
xangi-cmd discord_history --count <数量> --offset <偏移量>
xangi-cmd discord_history --channel <频道ID> --count <数量> --offset <偏移量>
\`\`\`

结果返回到标准输出（不会发送到 Discord）。
省略数量时默认为 10 条，最大 100 条。使用 offset 可以回溯更早的消息。
省略 \`--channel\` 时，如果在 xangi 中运行，则使用当前频道。单独在 CLI 执行时需要 \`--channel\`。

### 向其他频道发送消息

\`\`\`bash
xangi-cmd discord_send --channel <频道ID> --message "消息内容"
\`\`\`

### 频道列表

\`\`\`bash
xangi-cmd discord_channels --guild <服务器ID>
\`\`\`

### 搜索消息

\`\`\`bash
xangi-cmd discord_search --channel <频道ID> --keyword "关键词"
\`\`\`

### 编辑消息

\`\`\`bash
xangi-cmd discord_edit --channel <频道ID> --message-id <消息ID> --content "新内容"
\`\`\`

### 删除消息

\`\`\`bash
xangi-cmd discord_delete --channel <频道ID> --message-id <消息ID>
\`\`\`

### 发送文件

\`\`\`bash
xangi-cmd media_send --channel <频道ID> --file /path/to/file
\`\`\`

## 自动展开功能（只读）

- \`https://discord.com/channels/.../...\` 链接 → 展开链接指向的消息内容
- \`<#channelId>\` → 展开该频道的最新 10 条消息`;
