# Slack App 设置指南

在 Slack 上使用 xangi 所需的 App 创建步骤。

## 1. 访问 Slack API

https://api.slack.com/apps

使用 Slack 账号登录。

## 2. 创建新的 App

1. 点击 **“Create New App”**
2. 选择 **“From scratch”**
3. App Name: `xangi`（可使用任意名称）
4. 选择工作区
5. 点击 **“Create App”**

## 3. 启用 Socket Mode（重要）

xangi 使用 Socket Mode 运行（不需要 Webhook）。

1. 点击左侧菜单 **“Socket Mode”**
2. 将 **“Enable Socket Mode”** 设为 ON
3. 创建 App-Level Token：
   - Token Name: `xangi-socket`
   - Scopes: `connections:write`
   - 点击 **“Generate”**
4. **复制显示的 App Token（xapp-...）**

## 4. Event Subscriptions 设置

1. 点击左侧菜单 **“Event Subscriptions”**
2. 将 **“Enable Events”** 设为 ON
3. 在 **“Subscribe to bot events”** 中添加以下内容：

| Event | 说明 | 用途 |
|-------|------|------|
| `app_mention` | 被 @提及 时 | 必须 |
| `message.im` | 收到 DM 时 | 支持 DM 时 |
| `message.channels` | 公共频道的消息 | 无 @提及 响应时 |
| `message.groups` | 私有频道的消息 | 无 @提及 响应时 |

⚠️ **使用 `SLACK_AUTO_REPLY_CHANNELS` 时需要 `message.channels` / `message.groups`**

## 5. OAuth & Permissions 设置

1. 点击左侧菜单 **“OAuth & Permissions”**
2. 在 **“Scopes”** → **“Bot Token Scopes”** 中添加以下内容：

| Scope | 说明 | 用途 |
|-------|------|------|
| `app_mentions:read` | 读取 @提及 | 必须 |
| `chat:write` | 发送消息 | 必须 |
| `files:read` | 读取文件 | 支持附件时 |
| `reactions:write` | 添加反应（👀 等） | 必须 |
| `im:history` | 读取 DM 历史 | 支持 DM 时 |
| `im:read` | 读取 DM | 支持 DM 时 |
| `im:write` | 发送 DM | 支持 DM 时 |
| `channels:history` | 读取公共频道历史 | 无 @提及 响应时 |
| `groups:history` | 读取私有频道历史 | 无 @提及 响应时 |

## 6. 注册斜杠命令（可选）

1. 点击左侧菜单 **“Slash Commands”**
2. 创建以下命令：

| Command | Description |
|---------|-------------|
| `/new` | 开始新会话 |
| `/skills` | 可用技能列表 |
| `/skill` | 执行技能（Usage Hint: `<技能名> [参数]`） |

⚠️ 在 Socket Mode 下不需要 Request URL。

## 7. 安装到工作区

1. 点击左侧菜单 **“Install App”**
2. 点击 **“Install to Workspace”**
3. 确认权限并点击 **“允许”**
4. **复制显示的 Bot User OAuth Token（xoxb-...）**

## 8. 设置环境变量

```bash
# 编辑 .env 文件
vim .env
```

```bash
# Slack Bot Token（xoxb-...）
SLACK_BOT_TOKEN=xoxb-your-bot-token

# Slack App Token（xapp-...）用于 Socket Mode
SLACK_APP_TOKEN=xapp-your-app-token

# 允许的用户 ID（Slack 的用户 ID）
SLACK_ALLOWED_USER=U01234567
```

> **⚠️ 如果仅使用 Slack，请从 `.env` 中删除（或注释掉）`DISCORD_TOKEN`。**
> 如果设置了 `DISCORD_TOKEN`，则还需要 Discord 侧的设置（如 `DISCORD_ALLOWED_USER` 等）。

## 9. 验证运行

```bash
# 构建
npm run build

# 使用 Docker 启动
docker compose up -d --build

# 查看日志
docker logs -f xangi
```

在 Slack 中尝试以下操作：
- @提及 Bot：`@xangi 你好！`
- 发送 DM
- `/new` 命令
- `/skills` 命令

## ID 的查询方法

### 用户 ID

1. 打开用户的个人资料
2. 点击 **“︙”**（更多）→ **“复制成员 ID”**

### 频道 ID

**方法1：从链接获取**
1. 右键点击频道名称 → **“复制链接”**
2. URL 末尾即为频道 ID：`https://xxx.slack.com/archives/C01234567` ← `C01234567` 就是 ID

**方法2：从频道信息获取**
1. 打开频道 → 点击频道名称
2. 最下方会显示 **频道 ID**

## 故障排除

### Bot 没有反应

1. 确认 Socket Mode 是否已启用
2. 确认 Event Subscriptions 中是否设置了 `app_mention`、`message.im`
3. 确认 Bot 已被邀请到频道（`/invite @xangi`）
4. 确认 `ALLOWED_USER` 是否是 Slack 的用户 ID

### 斜杠命令不工作

1. 确认 Slash Commands 中是否已注册命令
2. 重新安装 App（权限变更后可能需要）

### “Slack tokens not configured” 错误

确认 `.env` 中是否设置了 `SLACK_BOT_TOKEN` 和 `SLACK_APP_TOKEN`。

### DM 中没有反应

1. 确认 OAuth Scopes 中是否有 `im:history`、`im:read`
2. 确认 Event Subscriptions 中是否设置了 `message.im`

## 将 Bot 邀请到频道

要在频道中使用 Bot，需要将 Bot 邀请到该频道：

```
/invite @xangi
```

## 安全注意事项

- **不要将 Token 提交到 Git**（`.gitignore` 已添加 `.env`）
- **不要公开 Token**（如果泄露，请在 Slack App 设置中重新生成）
- 使用 `ALLOWED_USER` 将可用用户限制为一人（遵守 Claude Code 使用条款）

## 参考链接

- [Slack API Documentation](https://api.slack.com/docs)
- [Bolt for JavaScript](https://slack.dev/bolt-js/)
- [Socket Mode](https://api.slack.com/apis/connections/socket)
