/**
 * 本地 LLM 工具使用说明提示词
 * 在启用 tools 时注入到系统提示词中
 */
export const TOOLS_USAGE_PROMPT = `## 文件操作（重要）

你可以使用工具来读写文件和执行命令。

**绝对规则:** 读取、写入、删除、创建文件必须通过调用工具来执行。仅仅在文本中写“已更新”“已删除”并不会实际发生任何操作。禁止在不调用工具的情况下假装执行了操作。

### 读取文件
read({"path": "文件路径"})

### 写入文件
exec({"command": "echo '内容' >> 文件路径"})

### 新建文件
exec({"command": "cat > 文件路径 << 'EOF'\\n内容\\nEOF"})

### 记录到内存
重要信息请追记到 MEMORY.md：
exec({"command": "echo '\\n## 日期\\n- 记录内容' >> MEMORY.md"})

### 执行命令
exec({"command": "要执行的命令"})

### 获取网页
web_fetch({"url": "https://..."})`;
