import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

const AGENTS_DIR = ".agents/agents";

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
  skills: string[];
}

let cachedTemplates: AgentTemplate[] | null = null;

/**
 * 从 .agents/agents/ 目录加载 Markdown 模板文件。
 * 每个文件为 Markdown + YAML frontmatter 格式：
 *   ---
 *   name: 模板名称
 *   description: 描述
 *   skills:
 *     - skill-name
 *   ---
 *   正文内容作为 prompt
 *
 * 文件名（不含扩展名）作为模板 id。
 * 结果按文件名字典序排列，带简单内存缓存（进程生命周期内只读一次磁盘）。
 */
export function loadAgentTemplates(): AgentTemplate[] {
  if (cachedTemplates) return cachedTemplates;

  const dir = join(process.cwd(), AGENTS_DIR);
  if (!existsSync(dir)) {
    cachedTemplates = [];
    return cachedTemplates;
  }

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  cachedTemplates = files.map((filename) => {
    const id = filename.replace(/\.md$/, "");
    const raw = readFileSync(join(dir, filename), "utf-8");

    // 解析 YAML frontmatter（兼容 \n / \r\n / \r 换行）
    const frontmatterMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    let name = id;
    let description = "";
    let prompt = raw;
    let skills: string[] = [];

    if (frontmatterMatch) {
      const parsed = yaml.load(frontmatterMatch[1]) as Record<string, unknown>;
      name = (parsed.name as string) ?? id;
      description = (parsed.description as string) ?? "";
      prompt = frontmatterMatch[2].trim();
      const skillsRaw = parsed.skills;
      skills = Array.isArray(skillsRaw) ? (skillsRaw as string[]) : [];
    }

    return { id, name, description, prompt, skills };
  });

  return cachedTemplates;
}
