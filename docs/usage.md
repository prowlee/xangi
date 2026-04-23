# 使用指南

xangi 的详细使用指南。

## 目录

- [基本操作](#基本操作)
- [频道主题注入](#频道主题注入)
- [时间戳注入](#时间戳注入)
- [会话管理](#会话管理)
- [调度器](#调度器)
- [Discord 命令](#discord-命令)
- [命令前缀](#命令前缀)
- [运行时设置](#运行时设置)
- [AI 自主操作](#ai-自主操作)
- [Standalone 模式](#standalone-模式)
- [Docker 运行](#docker-运行)
- [本地 LLM（Ollama）](#本地-llmollama)
- [故障排除](#故障排除)

## 基本操作

### 通过 @提及 调用

```
@xangi 问题内容
```

### 专用频道

在 `AUTO_REPLY_CHANNELS` 中设置的频道中，无需 @提及 即可响应。

## 频道主题注入

如果 Discord 频道的主题（概要）已设置，其内容会自动注入到提示词中。

可以为每个频道向 AI 传递不同的上下文或指令。

### 设置方法

在 Discord 的频道设置 → “主题” 中以自然语言描述指令。

### 使用示例

- `作业前务必阅读 ~/project/README.md`
- `此频道请用中文回复`
- `请先检索 memory-RAG 再回复`

如果主题为空，则不会注入任何内容。

## 时间戳注入

当前时间（JST）会自动注入到提示词的开头。AI 可以识别时间流逝，从而准确把握经过的时间并做出与时间相关的判断。

默认启用。要禁用它：

```bash
INJECT_TIMESTAMP=false
```

注入格式：`[当前时间: 2026/3/8 12:34:56]`

## 会话管理

| 命令                       | 说明                   |
| --------------------------- | ---------------------- |
| `/new`, `!new`, `new`       | 开始新会话 |
| `/clear`, `!clear`, `clear` | 清除会话历史 |

### Discord 按钮操作

响应消息中会显示按钮。

- **处理中**：`Stop` 按钮 — 等同于 `/stop`。中断任务
- **完成后**：`New` 按钮 — 等同于 `/new`。重置会话

可以通过 `DISCORD_SHOW_BUTTONS=false` 隐藏按钮。

### 危险命令的审批流程

当代理尝试执行危险命令时，Discord 中会显示带有按钮的确认消息。

```
⚠️ 检测到危险命令
git push origin main
Git push

[允许] [拒绝]
```

- 如果 2 分钟内没有响应，自动拒绝
- 同时支持 Claude Code / 本地 LLM 后端
- 通过审批服务器（`localhost:18181`）统一管理

**检测目标命令：**

| 类别 | 模式 | 说明 |
|---------|---------|------|
| 文件删除 | `rm -r`, `rm -f` | 递归/强制删除 |
| Git | `git push` | 推送到远程 |
| Git | `git reset --hard` | 丢弃更改 |
| Git | `git clean -f` | 删除未跟踪文件 |
| Git | `git branch -D` | 强制删除分支 |
| 权限 | `chmod 777` | 赋予全部权限 |
| 权限 | `chown -R` | 递归更改所有权 |
| 系统 | `shutdown`, `reboot` | 系统停止/重启 |
| 系统 | `kill -9`, `killall` | 强制终止进程 |
| 远程执行 | `curl \| sh`, `wget \| bash` | 执行远程脚本 |
| 数据库 | `DROP TABLE`, `TRUNCATE` | 删除数据库 |
| 敏感文件 | `cat .env`, `cat *.pem` | 读取认证信息 |
| 敏感文件 | 写入/编辑 `.env`, `.pem`, `credentials` | 修改认证信息 |

**Claude Code 后端的设置：**

在工作区的 `.claude/settings.json` 中添加 PreToolUse 钩子：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:18181/hooks/pre-tool-use",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

**本地 LLM 后端：** 无需设置。自动向审批服务器查询。

## 调度器

可以设置定时执行或提醒。AI 会解析自然语言并自动执行 `!schedule` 命令。

### 命令列表

| 命令                             | 说明                                 |
| ------------------------------- | ------------------------------------ |
| `/schedule`                     | 通过斜杠命令操作调度器 |
| `!schedule <时间> <消息>` | 添加日程 |
| `!schedule list` / `!schedule`  | 显示列表（所有频道） |
| `!schedule remove <编号>`       | 删除（可多个：`remove 1 2 3`） |
| `!schedule toggle <编号>`       | 启用/禁用切换 |

> 💡 也可以通过 `/schedule` 斜杠命令进行相同操作。

### 时间指定的写法

#### 一次性提醒

```
30分钟后 提醒我做某事
1小时后 会议准备
15:30 今天下午3点半通知
```

#### 重复（自然语言）

```
每天 9:00 早上好
每天 18:00 写日报
每周一 10:00 周报
每周五 17:00 确认周末计划
```

#### cron 表达式

需要更精细控制时也可以使用 cron 表达式：

```
0 9 * * * 每天9点
0 */2 * * * 每2小时
30 8 * * 1-5 工作日8:30
0 0 1 * * 每月1日
```

| 字段 | 值   | 说明                |
| ---------- | ---- | ------------------- |
| 分钟         | 0-59 |                     |
| 小时         | 0-23 |                     |
| 日期         | 1-31 |                     |
| 月份         | 1-12 |                     |
| 星期几       | 0-6  | 0=周日, 1=周一, ... |

### CLI（命令行）

```bash
# 添加日程
npx tsx src/schedule-cli.ts add --channel <频道ID> "每天 9:00 早上好"

# 显示列表
npx tsx src/schedule-cli.ts list

# 删除（指定编号）
npx tsx src/schedule-cli.ts remove --channel <频道ID> 1

# 删除多个
npx tsx src/schedule-cli.ts remove --channel <频道ID> 1 2 3

# 启用/禁用切换
npx tsx src/schedule-cli.ts toggle --channel <频道ID> 1
```

### 数据保存

日程数据保存在 `${DATA_DIR}/schedules.json` 中。

- 默认：`/workspace/.xangi/schedules.json`
- 可通过环境变量 `DATA_DIR` 更改

## Discord 操作（xangi-cmd）

AI 通过 `xangi-cmd` CLI 工具执行 Discord 操作。由于通过 xangi 内置的 tool-server（HTTP API）进行中继，DISCORD_TOKEN 等密钥无法被 AI CLI 访问。

| 命令 | 说明 |
|----------|------|
| `xangi-cmd discord_history --channel <ID> [--count N] [--offset M]` | 获取频道历史记录 |
| `xangi-cmd discord_send --channel <ID> --message "文本"` | 发送消息 |
| `xangi-cmd discord_channels --guild <ID>` | 频道列表 |
| `xangi-cmd discord_search --channel <ID> --keyword "文本"` | 搜索消息 |
| `xangi-cmd discord_edit --channel <ID> --message-id <ID> --content "文本"` | 编辑消息 |
| `xangi-cmd discord_delete --channel <ID> --message-id <ID>` | 删除消息 |
| `xangi-cmd media_send --channel <ID> --file /path/to/file` | 发送文件 |

### 使用示例

```bash
# 获取频道历史记录
xangi-cmd discord_history --count 10
xangi-cmd discord_history --channel 1234567890 --count 10
xangi-cmd discord_history --channel 1234567890 --count 30 --offset 30  # 回溯

# 向其他频道发送消息
xangi-cmd discord_send --channel 1234567890 --message "作业完成了！"

# 频道列表
xangi-cmd discord_channels --guild 9876543210

# 搜索消息
xangi-cmd discord_search --channel 1234567890 --keyword "PR"
```

如果省略 `--channel`，在 xangi 中运行时将使用当前频道 ID。单独在 CLI 执行时需要 `--channel`。

```bash
# 编辑/删除消息
xangi-cmd discord_edit --channel 1234567890 --message-id 111222333 --content "修改后的内容"
xangi-cmd discord_delete --channel 1234567890 --message-id 111222333
```

### 工具服务器

xangi-cmd 中继到 xangi 进程内的 tool-server（HTTP API）。

- 端口由操作系统自动分配（多实例无冲突）
- xangi 主进程启动时将 `XANGI_TOOL_SERVER` 注入子进程
- `xangi-cmd` 使用 `XANGI_TOOL_SERVER` 解析连接地址
- 当前频道 ID 等 xangi 执行时的上下文作为 `context` 传递给 tool-server

## 跳过权限确认

默认情况下，AI 在创建文件或执行命令时会要求权限确认。
使用 `!skip` 前缀或 `/skip` 斜杠命令可以跳过权限确认。

设置环境变量 `SKIP_PERMISSIONS=true` 后，默认所有消息都将处于跳过模式。

### `!skip` 前缀

在消息开头加上 `!skip`，仅对该消息以跳过模式执行。

### `/skip` 斜杠命令

使用 `/skip 消息` 可以跳过权限确认并执行消息。与 `!skip` 前缀行为相同。

### 使用示例

```
@xangi !skip gh pr list
!skip 构建一下                    # 在专用频道中无需 @提及
/skip 构建一下                    # 斜杠命令版本
```

## 运行时设置

运行时设置保存在 `${WORKSPACE_PATH}/settings.json` 中。

```json
{
  "autoRestart": true
}
```

| 设置          | 说明                             | 默认值 |
| ------------- | -------------------------------- | ---------- |
| `autoRestart` | 允许 AI 代理重启 | `true`     |

### 查看/更改设置

| 命令        | 说明             |
| ----------- | ---------------- |
| `/settings` | 显示当前设置 |
| `/restart`  | 重启机器人   |

### 后端动态切换

可以为每个频道切换后端、模型和 effort 级别。

| 命令                                                  | 说明                                   |
| ----------------------------------------------------- | -------------------------------------- |
| `/backend show`                                   | 显示当前后端和模型       |
| `/backend set claude-code`                        | 切换到 Claude Code                  |
| `/backend set local-llm --model nemotron-3-nano`  | 切换本地 LLM 并指定模型                 |
| `/backend set claude-code --effort high`          | 切换并指定 effort               |
| `/backend reset`                                  | 恢复默认（.env 设置）           |
| `/backend list`                                   | 可用后端/模型列表     |

切换时会自动开始新会话（不会继承对话历史）。

#### 通过环境变量限制

```bash
# 允许切换的后端（未设置=不可切换）
ALLOWED_BACKENDS=claude-code,local-llm

# 允许切换的模型（未设置=无限制）
ALLOWED_MODELS=nemotron-3-nano,nemotron-3-super,qwen3.5:9b

# 按频道的后端设置（JSON）
CHANNEL_OVERRIDES={"频道ID":{"backend":"local-llm","model":"nemotron-3-nano"}}
```

#### 持久化

通过 `/backend set` 更改的设置会自动保存到 `.env` 的 `CHANNEL_OVERRIDES` 中。重启后设置仍然有效。

在 Docker 环境中，`.env` 位于容器外部，因此不会被 AI（如 Claude Code）更改。

#### effort 选项（用于 Claude Code）

可以为每个频道设置 Claude Code 的 `--effort` 选项（`low` / `medium` / `high` / `max`）。在 persistent 模式下，切换时需要重启进程，因此会话会被重置。使用 `/backend set claude-code --effort 默认` 可以恢复到未指定状态。

## AI 自主操作

### 更改设置（仅在本地运行时）

AI 可以编辑 `.env` 文件来更改设置：

```
「这个频道也请回复」
→ AI 编辑 AUTO_REPLY_CHANNELS → 重启
```

### 系统命令

AI 输出的特殊命令：

| 命令                     | 说明           |
| ------------------------ | -------------- |
| `SYSTEM_COMMAND:restart` | 重启机器人 |

### 消息分割分隔符

如果 AI 的响应文本中包含 `\n===\n`（前后包含换行符的 `===`），将从该位置分割并作为单独的消息发送。这不仅适用于通过调度器的响应，也适用于直接来自 Discord @提及 的消息。当一次 LLM 响应需要生成多条独立消息时非常有用。

```
📝 推文解析1
> 推文正文...

===
📝 推文解析2
> 推文正文...
```

上述响应将作为两条独立消息发送到 Discord。

### 重启机制

- **Docker**：通过 `restart: always` 自动恢复
- **本地**：需要 pm2 等进程管理器

```bash
# 使用 pm2 运行的示例
pm2 start "npm start" --name xangi
pm2 logs xangi
```

### 通过 pm2 更改环境变量时

xangi 使用 `node --env-file=.env` 读取环境变量。如果要更改环境变量，**请先编辑 `.env` 文件，然后执行 `pm2 restart`**。

```bash
# 正确的方法：编辑 .env 后重启
vim .env  # 添加 TIMEOUT_MS=60000
pm2 restart xangi
```

> **⚠️ 不要使用 `pm2 restart --update-env`！**
> `--update-env` 会将 shell 的所有环境变量保存到 pm2 中。如果运行了多个 xangi 实例，可能导致其他实例的 `DISCORD_TOKEN` 等混入，造成使用相同 bot 令牌重复登录的问题。
> `node --env-file=.env` 不会覆盖现有的环境变量，因此 pm2 预先设置的值会优先。

## Standalone 模式

如果有 Docker 环境，只需一条命令即可启动 AI 助手。不需要 Discord/Slack 的令牌。使用本地 LLM（Ollama）+ Web 聊天 UI 运行。

### 设置

```bash
git clone https://github.com/karaage0703/xangi.git
cd xangi
./quickstart.sh
```

在浏览器中访问 `http://localhost:18888` 开始聊天。

### 工作原理

- **Ollama** — 本地 LLM 服务器（首次启动时自动下载 gemma4:e4b）
- **xangi** — AI 助手（带 Web 聊天 UI）
- **[ai-assistant-workspace](https://github.com/karaage0703/ai-assistant-workspace)** — 工作区（AGENTS.md、技能、记忆）

### 更改模型

```bash
LOCAL_LLM_MODEL=gemma4:26b ./quickstart.sh
```

### 停止

```bash
docker compose -f docker-compose.standalone.yml down
```

### 工作区持久化

工作区挂载到主机的 `workspace/` 目录。即使容器停止或删除，数据也会保留。也可以直接编辑 `workspace/` 中的文件并进行 git push。

## Docker 运行

可以在容器隔离环境中运行。提供了三种容器：

| 容器 | Dockerfile | 用途 |
|---|---|---|
| `xangi` | `Dockerfile` | 轻量版（Claude Code / Codex / Gemini CLI） |
| `xangi-max` | `Dockerfile.max` | 完整版（支持 uv + Python，面向本地 LLM） |
| `xangi-gpu` | `Dockerfile.gpu` | GPU 版（CUDA + PyTorch，面向图像生成/音频处理） |

### Claude Code 后端

```bash
docker compose up xangi -d --build

# Claude Code 认证
docker exec -it xangi claude
```

### 本地 LLM 后端（Ollama）

由于 Ollama 容器已包含在内，无需在主机上安装 Ollama。

```bash
# 设置 .env
AGENT_BACKEND=local-llm
LOCAL_LLM_MODEL=nemotron-3-nano

# 启动（ollama + xangi-max）
docker compose up xangi-max -d --build
```

### GPU 版（CUDA + Python + PyTorch）

可以使用 PyTorch（支持 CUDA），并且在 DGX Spark（ARM64）上也能运行。

```bash
# 启动（xangi-gpu + ollama）
docker compose up xangi-gpu -d --build

# Claude Code 认证
docker exec -it xangi-gpu claude

# 确认 GPU
docker exec -it xangi-gpu python3 -c "import torch; print(torch.cuda.is_available())"
```

> **💡 提示**：`xangi-gpu` 是 `xangi-max` 的超集。如果需要使用依赖 GPU/PyTorch 的技能（如语音转文字、图像生成等），请选择此版本。

### Docker 操作

```bash
# 停止
docker compose down

# 重启（例如更改 .env 后）
docker compose up xangi-max -d --force-recreate

# 查看日志
docker logs -f xangi-max
```

### 工作区挂载

| 环境 | 变量 | 说明 |
|---|---|---|
| 本地 | `WORKSPACE_PATH` | 代理直接使用的路径 |
| Docker | `XANGI_WORKSPACE` | 主机侧路径（容器内固定为 `/workspace`） |

在 Docker 运行时，请在 `.env` 中设置 `XANGI_WORKSPACE`：

```bash
XANGI_WORKSPACE=/home/user/my-workspace
```

> **⚠️ 不要使用 `WORKSPACE_PATH`。** 可能与主机的 shell 环境变量冲突。

### 安全性

- 容器**无法直接访问**主机网络
- Ollama 容器在同一 docker 网络内隔离
- 传递给 AI 代理的环境变量通过白名单方式限制（`DISCORD_TOKEN` 等无法访问）

## 本地 LLM（Ollama）

xangi 的本地 LLM 后端使用 OpenAI 兼容 API（`/v1/chat/completions`）。

### 本地运行（Ollama）

```bash
# 设置 .env
AGENT_BACKEND=local-llm
LOCAL_LLM_MODEL=gpt-oss:20b
# LOCAL_LLM_BASE_URL=http://localhost:11434  # 默认
```

如果 Ollama 正在运行，即可直接使用。

所有后端都会保存按会话的转录日志（`logs/sessions/<appSessionId>.jsonl`）。提示词、响应和错误会按会话记录在 JSONL 文件中。

关于 Docker 运行，请参阅 [Docker 运行](#docker-运行) 部分。

### 功能的单独控制

本地 LLM 的各个功能可以通过环境变量单独开启/关闭。

```bash
# .env — 示例：仅禁用工具
LOCAL_LLM_TOOLS=false

# 示例：闲聊机器人（全部关闭）
LOCAL_LLM_TOOLS=false
LOCAL_LLM_SKILLS=false
LOCAL_LLM_XANGI_COMMANDS=false

# 示例：带触发器的闲聊
LOCAL_LLM_TOOLS=false
LOCAL_LLM_SKILLS=false
LOCAL_LLM_XANGI_COMMANDS=false
LOCAL_LLM_TRIGGERS=true
```

| 变量 | 说明 | 默认值 |
|------|------|-----------|
| `LOCAL_LLM_TOOLS` | 工具执行（exec/read/web_fetch） | `true` |
| `LOCAL_LLM_SKILLS` | 技能列表注入 | `true` |
| `LOCAL_LLM_XANGI_COMMANDS` | XANGI_COMMANDS 注入 | `true` |
| `LOCAL_LLM_TRIGGERS` | 触发器（!命令） | `false` |

也可以使用 `LOCAL_LLM_MODE` 预设（单独设置优先）：
- `agent`（默认）— 全部开启
- `chat` — 全部关闭
- `lite` — triggers=true，其他关闭

工作区上下文（AGENTS.md 等）在任何设置下都会被注入。

### Triggers（自定义工具）

只需在工作区的 `triggers/` 目录中放置 shell 脚本，即可添加 LLM 可用的自定义工具。通过 `LOCAL_LLM_TRIGGERS=true` 启用。

LLM 通过 function calling 调用触发器，执行 handler.sh 并返回结果。

#### 设置

在工作区中创建 `triggers/` 目录，并为每个命令放置一个子目录。

```
workspace/
  triggers/
    weather/
      trigger.yaml    # 触发器定义
      handler.sh      # 执行脚本
    search/
      trigger.yaml
      handler.sh
```

#### trigger.yaml 格式

```yaml
name: weather
description: "获取天气预报（例如：weather 名古屋）"
handler: handler.sh
```

| 字段 | 必须 | 说明 |
|-----------|------|------|
| `name` | 是 | 工具名称（LLM 通过 function calling 调用的名称） |
| `description` | 否 | 工具说明（包含在传递给 LLM 的工具定义中） |
| `handler` | 是 | 执行脚本的文件名 |

#### handler 规范

- 以工作区根目录为 `cwd`，通过 `bash handler.sh [参数...]` 执行
- 参数是 LLM 通过 function calling 传递的 `args`，以空格分隔传递
- 超时：`EXEC_TIMEOUT_MS`（默认 120 秒）
- `stdout` 的内容返回给 LLM，LLM 会生成自然的响应

#### 工作流程

1. xangi 启动时扫描工作区的 `triggers/` 目录，自动生成工具定义
2. 向 LLM 注册为自定义工具
3. LLM 通过 function calling 调用工具
4. handler.sh 被执行，结果返回给 LLM
5. LLM 根据结果生成自然的响应

#### 注意事项

- 在启用工具的模式（lite/agent）下工作
- 添加新的触发器后请重启 xangi

### 多模态（图像输入）

本地 LLM 后端支持图像输入。在 Discord/Slack 中附加图像并发送消息后，可以将图像内容传递给 LLM 并请求分析或说明。

#### 支持的图像格式

JPEG (.jpg, .jpeg)、PNG (.png)、GIF (.gif)、WebP (.webp)

#### 支持的 LLM 服务器

- **Ollama** — 通过 `/api/chat` 的 `images` 字段（base64 格式）发送图像
- **OpenAI 兼容 API（vLLM 等）** — 以数组形式发送 `messages[].content`（`text` + `image_url`）

如果端点 URL 包含端口 `11434` 或 `ollama`，则使用 Ollama 格式，否则使用 OpenAI 兼容格式。

#### 使用示例

```
@xangi 请说明这张图片
（附加图片）
```

非图像文件（PDF、文本等）会像以前一样作为文件路径传递给提示词。

#### 注意事项

- 需要支持多模态的模型（例如：`llava`、`llama3.2-vision` 等）
- 图像以 base64 编码直接发送（不调整大小）
- 如果没有图像，则像以前一样仅使用文本（向后兼容）

### 会话管理和自动重试

本地 LLM 后端为每个频道保留会话（对话历史）。当发生因会话历史导致的错误（如超出上下文长度、消息格式无效等）时，会自动清除会话并仅使用最后一条用户消息重试。

### 错误处理

| 错误 | 消息 |
|--------|-----------|
| ECONNREFUSED / fetch failed | 无法连接到 LLM 服务器。请确认服务器是否已启动。 |
| timeout / aborted | LLM 响应超时。请稍后重试。 |
| 401 / 403 | LLM 服务器认证失败。请检查 API 密钥。 |
| 429 | 已达到 LLM 服务器的速率限制。请稍后重试。 |
| 500 / 502 / 503 | LLM 服务器发生内部错误。请稍后重试。 |
| 其他 | LLM 错误：（原始错误消息） |

### 支持的模型示例

| 模型 | 大小 | 特点 | 备注 |
|--------|--------|------|------|
| `gpt-oss:20b` | 13GB | MoE、高质量、支持工具调用 | 推荐 |
| `gpt-oss:120b` | 65GB | MoE（激活 12B）、最高质量 | 需要大内存 |
| `nemotron-3-nano` | 24GB | Mamba 混合、高速 | |
| `nemotron-3-super` | 86GB | Mamba 混合、高精度 | 需要大内存 |
| `qwen3.5:9b` | 6.6GB | 轻量、支持 Thinking | |
| `Qwen3.5-27B-FP8` | 29GB | 工具调用高精度、约 6 tok/s | 推荐 vLLM |

也支持其他在 Ollama/vLLM 上可用的模型。

## 安全性

### 环境变量白名单

传递给 AI 代理（CLI spawn / 本地 LLM exec）的环境变量在 `src/safe-env.ts` 中管理。只有白名单中列出的变量会被传递，`DISCORD_TOKEN` 等密钥无法被 AI 访问。

**允许的变量：** `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `TZ`, `NODE_ENV`, `NODE_PATH`, `WORKSPACE_PATH`, `AGENT_BACKEND`, `AGENT_MODEL`, `SKIP_PERMISSIONS`, `DATA_DIR`, `XANGI_TOOL_SERVER`, `XANGI_CHANNEL_ID`

**不传递的变量（示例）：** `DISCORD_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `LOCAL_LLM_API_KEY`, `GH_TOKEN`

要更改白名单，请编辑 `src/safe-env.ts` 中的 `ALLOWED_ENV_KEYS`。

## 环境变量列表

### Discord

| 变量 | 说明 | 默认值 |
|------|------|-----------|
| `DISCORD_TOKEN` | Discord Bot Token | **必须** |
| `DISCORD_ALLOWED_USER` | 允许的用户 ID（逗号分隔可多个，`*` 允许所有人） | **必须** |
| `AUTO_REPLY_CHANNELS` | 无需 @提及 即可响应的频道 ID（逗号分隔） | - |
| `DISCORD_STREAMING` | 流式输出 | `true` |
| `DISCORD_SHOW_THINKING` | 显示思考过程 | `true` |
| `INJECT_CHANNEL_TOPIC` | 将频道主题注入提示词 | `true` |
| `INJECT_TIMESTAMP` | 将当前时间注入提示词 | `true` |

### AI 代理

| 变量 | 说明 | 默认值 |
|------|------|-----------|
| `AGENT_BACKEND` | 后端（`claude-code` / `codex` / `gemini` / `local-llm`） | `claude-code` |
| `AGENT_MODEL` | 使用的模型 | - |
| `WORKSPACE_PATH` | 工作目录（本地运行时） | `./workspace` |
| `XANGI_WORKSPACE` | 工作区的主机侧路径（Docker 运行时） | `./workspace` |
| `SKIP_PERMISSIONS` | 默认跳过权限确认 | `false` |
| `TIMEOUT_MS` | 超时（毫秒） | `300000` |
| `PERSISTENT_MODE` | 常驻进程模式 | `true` |
| `MAX_PROCESSES` | 同时执行进程数的上限 | `10` |
| `IDLE_TIMEOUT_MS` | 空闲进程的自动终止时间 | `1800000` |
| `DATA_DIR` | 数据保存目录 | `.xangi` |
| `GH_TOKEN` | GitHub CLI 令牌 | - |

### GitHub App 认证（可选）

如果有 GitHub App 配置，可以在执行 `gh` CLI 时自动生成安装令牌。无需 PAT 或 `gh auth login`。

| 变量 | 说明 |
|------|------|
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_APP_INSTALLATION_ID` | 安装 ID |
| `GITHUB_APP_PRIVATE_KEY_PATH` | 私钥文件路径 |

如果不设置，则继续使用传统的 `gh` 认证（`gh auth login` / `GH_TOKEN`）。

**Docker 环境：** 私钥会自动挂载到 `/secrets/github-app.pem`。请在 `.env` 中设置主机侧的路径。

**安全性：** 如果令牌生成失败，不会回退到 PAT，而是报错。在 `gh` 执行时，工具显示中会显示 `🔑App` 徽章。

### 本地 LLM（`AGENT_BACKEND=local-llm` 时）

| 变量 | 说明 | 默认值 |
|------|------|-----------|
| `LOCAL_LLM_BASE_URL` | LLM 服务器 URL | `http://localhost:11434` |
| `LOCAL_LLM_MODE` | 预设（`agent` / `chat` / `lite`） | `agent` |
| `LOCAL_LLM_TOOLS` | 工具执行 | `true` |
| `LOCAL_LLM_SKILLS` | 技能列表注入 | `true` |
| `LOCAL_LLM_XANGI_COMMANDS` | XANGI_COMMANDS 注入 | `true` |
| `LOCAL_LLM_TRIGGERS` | 触发器（!命令） | `false` |
| `LOCAL_LLM_MODEL` | 使用的模型名称 | - |
| `LOCAL_LLM_API_KEY` | API 密钥（vLLM 等需要时） | - |
| `LOCAL_LLM_THINKING` | 是否启用 Thinking 模型的推理 | `true` |
| `LOCAL_LLM_MAX_TOKENS` | 最大令牌数 | `8192` |
| `LOCAL_LLM_NUM_CTX` | 上下文窗口大小（用于 Ollama） | 模型的默认值 |
| `EXEC_TIMEOUT_MS` | exec 工具的超时时间（毫秒） | `120000` |
| `WEB_FETCH_TIMEOUT_MS` | web_fetch 工具的超时时间（毫秒） | `15000` |

### Slack

| 变量 | 说明 |
|------|------|
| `SLACK_BOT_TOKEN` | Slack Bot Token（xoxb-...） |
| `SLACK_APP_TOKEN` | Slack App Token（xapp-...） |
| `SLACK_ALLOWED_USER` | 允许的用户 ID |
| `SLACK_AUTO_REPLY_CHANNELS` | 无需 @提及 即可响应的频道 ID |
| `SLACK_REPLY_IN_THREAD` | 是否在线程中回复（默认：`true`） |

## 故障排除

### “Prompt is too long” 错误

**症状：** 在特定频道中，对所有消息都返回“❌ 发生错误：Prompt is too long”。

**原因：** 会话的对话历史超过了 Claude Code（Agent SDK）的上下文限制。通常 Agent SDK 会自动压缩上下文，但如果会话异常终止等，状态可能损坏且无法恢复。

**解决方法：**

1. 在该频道中执行 `/new` 命令重置会话
2. 如果仍未解决，请重启 xangi（`pm2 restart xangi`）
