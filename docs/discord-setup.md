# Discord Bot 设置指南

在 Discord 上使用 xangi 所需的 Bot 创建步骤。

## 1. 访问 Discord Developer Portal

https://discord.com/developers/applications

使用 Discord 账号登录。

## 2. 创建新的应用程序

1. 点击右上角的 **“New Application”**
2. 输入名称：`xangi`（可使用任意名称）
3. 点击 **“Create”**

## 3. 创建 Bot 并获取 Token

1. 点击左侧菜单中的 **“Bot”**
2. 点击 **“Reset Token”** → **“Yes, do it!”**
3. **复制显示的 Token**（稍后使用）

⚠️ **注意**：Token 只会显示一次。如果丢失，需要重新生成。

## 4. Bot 权限设置（重要）

在同一 Bot 页面中设置 **Privileged Gateway Intents**：

| Intent | 是否必须 | 说明 |
|--------|------|------|
| Presence Intent | 可选 | 获取用户的在线状态 |
| Server Members Intent | 可选 | 获取服务器成员信息 |
| **Message Content Intent** | **必须** | 读取消息内容 |

**⚠️ 如果不开启 Message Content Intent，Bot 将无法读取消息！**

## 5. 邀请 Bot 加入服务器

1. 点击左侧菜单 **“OAuth2”** → **“URL Generator”**
2. 在 **SCOPES** 中选择：
   - ✅ `bot`
   - ✅ `applications.commands`（用于斜杠命令）
3. 在 **BOT PERMISSIONS** 中选择：
   - ✅ Send Messages（发送消息）
   - ✅ Send Messages in Threads（在线程中发送消息）
   - ✅ Read Message History（读取消息历史）
   - ✅ Add Reactions（添加反应）
   - ✅ Use Slash Commands（使用斜杠命令）
4. 复制生成的 URL
5. 在浏览器中打开 URL，选择要邀请 Bot 的服务器

## 6. 设置环境变量

```bash
# 编辑 .env 文件
cp .env.example .env
vim .env
```

```bash
# Discord Bot Token
DISCORD_TOKEN=YOUR_BOT_TOKEN_HERE

# 允许的用户 ID（仅限一人）
ALLOWED_USER=YOUR_DISCORD_USER_ID
```

## 7. 验证运行

```bash
# 构建
npm run build

# 使用 Docker 启动
docker compose up -d --build

# 查看日志
docker logs -f xangi
```

在 Discord 服务器中尝试 `/new` 或 `/skills` 命令，或者 @提及 Bot 并与之对话：
```
@xangi 你好！
```

## ID 的查询方法

### 启用开发者模式

1. Discord 设置 → 高级设置 → 开启 **开发者模式**

### 用户 ID

1. 右键点击用户 → **“复制用户 ID”**

### 频道 ID

1. 右键点击频道 → **“复制频道 ID”**

## 故障排除

### Bot 没有反应

1. 确认 **Message Content Intent** 是否已开启
2. 确认 Bot 已被邀请到服务器
3. 确认 `ALLOWED_USER` 设置是否正确

### 斜杠命令不显示

1. 确认是否使用了 `applications.commands` 范围进行邀请
2. 将 Bot 从服务器中删除后重新邀请
3. 重启 Discord

### “Discord token not configured” 错误

`.env` 中的 `DISCORD_TOKEN` 为空。请设置 Token。

## 安全注意事项

- **不要将 Token 提交到 Git**（`.gitignore` 已添加 `.env`）
- **不要公开 Token**（如果泄露，请立即重新生成）
- 使用 `ALLOWED_USER` 将可用用户限制为一人（遵守 Claude Code 使用条款）
