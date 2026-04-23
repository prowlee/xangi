/**
 * 图像处理工具（本地 LLM 多模态支持）
 */
import fs from 'fs';
import path from 'path';

/** 支持的图片扩展名 */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

/** 扩展名 → MIME 类型映射 */
const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * 判断文件路径是否为图片文件
 */
export function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * 根据文件扩展名获取 MIME 类型
 */
export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * 读取图片文件并编码为 base64
 * @returns base64 编码的图片数据，若文件不存在或无法读取则返回 null
 */
export function encodeImageToBase64(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`[local-llm] 图片文件不存在: ${filePath}`);
      return null;
    }

    const buffer = fs.readFileSync(filePath);
    return buffer.toString('base64');
  } catch (err) {
    console.warn(
      `[local-llm] 读取图片文件失败: ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * 从提示词中提取「[附件]」部分的文件路径
 * @returns { imagePaths: 图片文件路径列表, otherPaths: 非图片文件路径列表, cleanPrompt: 移除附件部分后的提示词 }
 */
export function extractAttachmentPaths(prompt: string): {
  imagePaths: string[];
  otherPaths: string[];
  cleanPrompt: string;
} {
  const imagePaths: string[] = [];
  const otherPaths: string[] = [];

  // 检测 [附件] 部分
  const attachmentMatch = prompt.match(/\n\n\[附件\]\n([\s\S]*?)$/);
  if (!attachmentMatch) {
    return { imagePaths, otherPaths, cleanPrompt: prompt };
  }

  const fileListText = attachmentMatch[1];
  const cleanPrompt = prompt.slice(0, attachmentMatch.index).trim();

  // 从每行提取文件路径（格式："  - /path/to/file"）
  const lines = fileListText.split('\n');
  for (const line of lines) {
    const pathMatch = line.match(/^\s+-\s+(.+)$/);
    if (pathMatch) {
      const filePath = pathMatch[1].trim();
      if (isImageFile(filePath)) {
        imagePaths.push(filePath);
      } else {
        otherPaths.push(filePath);
      }
    }
  }

  return { imagePaths, otherPaths, cleanPrompt };
}
