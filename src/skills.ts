import { readdirSync, existsSync, readFileSync, statSync } from 'fs';
import { join, basename } from 'path';
import { DISCORD_SAFE_LENGTH } from './constants.js';

export interface Skill {
  name: string;
  description: string;
  path: string;
}

/**
 * 从工作区的技能目录读取技能列表
 * 查找 .claude/skills/、.codex/skills/、skills/，并排除重复项
 */
export function loadSkills(workdir: string): Skill[] {
  const skillMap = new Map<string, Skill>();

  // 查找多个技能目录（按优先级顺序）
  const skillsDirs = [
    join(workdir, '.claude', 'skills'), // Claude Code 格式
    join(workdir, '.codex', 'skills'), // Codex 格式
    join(workdir, 'skills'), // 标准格式
  ];

  for (const skillsDir of skillsDirs) {
    const loaded = loadSkillsFromDir(skillsDir);
    for (const skill of loaded) {
      // 同名技能优先使用最先找到的（去重）
      if (!skillMap.has(skill.name)) {
        skillMap.set(skill.name, skill);
      }
    }
  }

  return Array.from(skillMap.values());
}

/**
 * 从指定目录读取技能
 */
function loadSkillsFromDir(skillsDir: string): Skill[] {
  const skills: Skill[] = [];

  if (!existsSync(skillsDir)) {
    return skills;
  }

  try {
    const entries = readdirSync(skillsDir);

    for (const entry of entries) {
      const entryPath = join(skillsDir, entry);
      const stat = statSync(entryPath);

      if (stat.isDirectory()) {
        // skills/skill-name/SKILL.md 格式
        const skillFile = join(entryPath, 'SKILL.md');
        if (existsSync(skillFile)) {
          const skill = parseSkillFile(skillFile, entry);
          if (skill) {
            skills.push(skill);
          }
        }
      } else if (entry.endsWith('.md') && entry !== 'README.md') {
        // skills/skill-name.md 格式
        const skillName = basename(entry, '.md');
        const skill = parseSkillFile(entryPath, skillName);
        if (skill) {
          skills.push(skill);
        }
      }
    }
  } catch (err) {
    console.error('[skills] 加载技能失败:', err);
  }

  return skills;
}

/**
 * 解析 SKILL.md 文件并提取技能信息
 */
function parseSkillFile(filePath: string, defaultName: string): Skill | null {
  try {
    const content = readFileSync(filePath, 'utf-8');

    // 从 frontmatter 中提取 description
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    let description = '';
    let name = defaultName;

    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      const descMatch = frontmatter.match(/description:\s*["']?([^"'\n]+)["']?/);
      const nameMatch = frontmatter.match(/name:\s*["']?([^"'\n]+)["']?/);

      if (descMatch) {
        description = descMatch[1].trim();
      }
      if (nameMatch) {
        name = nameMatch[1].trim();
      }
    }

    // 如果没有 frontmatter，从第一个标题或段落获取描述
    if (!description) {
      const lines = content
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('---'));
      if (lines.length > 0) {
        description = lines[0].slice(0, 100);
      }
    }

    return {
      name,
      description: description || '(无说明)',
      path: filePath,
    };
  } catch {
    return null;
  }
}

/**
 * 格式化技能列表（适配 Discord 2000 字符限制）
 */
export function formatSkillList(skills: Skill[]): string {
  if (skills.length === 0) {
    return '📚 没有可用的技能\n\n请在 `skills/` 目录中添加 SKILL.md 文件。';
  }

  const lines = [`📚 **可用技能** (${skills.length}项)`, ''];
  for (const skill of skills) {
    // 将描述截断为50个字符
    const shortDesc =
      skill.description.length > 50 ? skill.description.slice(0, 50) + '...' : skill.description;
    lines.push(`• **${skill.name}**: ${shortDesc}`);
  }
  lines.push('', '使用方法: `/skill <技能名>`');

  const result = lines.join('\n');
  // 适配 Discord 字符数限制
  if (result.length > DISCORD_SAFE_LENGTH) {
    const shortLines = [`📚 **可用技能** (${skills.length}项)`, ''];
    for (const skill of skills) {
      shortLines.push(`• **${skill.name}**`);
    }
    shortLines.push('', '使用方法: `/skill <技能名>`');
    return shortLines.join('\n');
  }
  return result;
}
