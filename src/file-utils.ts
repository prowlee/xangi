import fs from 'fs';
import path from 'path';
import os from 'os';

const DOWNLOAD_DIR = path.join(
  process.env.DATA_DIR || path.join(os.homedir(), '.xangi'),
  'media',
  'attachments'
);

// 创建下载目录
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

/**
 * 从 URL 下载文件并保存到临时文件
 */
export async function downloadFile(
  url: string,
  filename: string,
  authHeader?: Record<string, string>
): Promise<string> {
  const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = path.join(DOWNLOAD_DIR, `${Date.now()}_${sanitized}`);

  const headers: Record<string, string> = { ...authHeader };
  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`下载文件失败: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filePath, buffer);
  console.log(`[xangi] 已下载附件: ${filename} → ${filePath} (${buffer.length} 字节)`);
  return filePath;
}

/**
 * 从 Agent 结果中提取文件路径
 * 模式: MEDIA:/path/to/file 或 [文件](/path/to/file)
 */
export function extractFilePaths(text: string): string[] {
  const paths: string[] = [];

  // MEDIA:/path/to/file 模式
  const mediaPattern = /MEDIA:\s*([^\s\n]+)/g;
  let match;
  while ((match = mediaPattern.exec(text)) !== null) {
    const p = match[1].trim();
    if (fs.existsSync(p)) {
      paths.push(p);
    }
  }

  // 绝对路径模式（具有图片/音频/视频扩展名的文件）
  const absPathPattern =
    /(?:^|\s)(\/[^\s]+\.(?:png|jpg|jpeg|gif|webp|mp3|mp4|wav|flac|pdf|zip))/gim;
  while ((match = absPathPattern.exec(text)) !== null) {
    const p = match[1].trim();
    if (fs.existsSync(p) && !paths.includes(p)) {
      paths.push(p);
    }
  }

  return paths;
}

/**
 * 从文本中移除文件路径部分，返回用于显示的文本
 */
export function stripFilePaths(text: string): string {
  return text
    .replace(/MEDIA:\s*[^\s\n]+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 将附件信息添加到提示词中
 */
export function buildPromptWithAttachments(prompt: string, filePaths: string[]): string {
  if (filePaths.length === 0) return prompt;

  const fileList = filePaths.map((p) => `  - ${p}`).join('\n');
  return `${prompt}\n\n[附件]\n${fileList}`;
}
