import { existsSync } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

const AGENTS_DIR = ".agents/agents";

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

let cachedTemplates: AgentTemplate[] | null = null;

/**
 * 从 .agents/agents/ 目录加载 YAML 模板文件。
 * 每个文件的文件名（不含扩展名）作为模板 id。
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
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();

  cachedTemplates = files.map((filename) => {
    const id = filename.replace(/\.(yaml|yml)$/, "");
    const raw = readFileSync(join(dir, filename), "utf-8");
    const parsed = yaml.load(raw) as Record<string, string>;
    return {
      id,
      name: parsed.name ?? id,
      description: parsed.description ?? "",
      prompt: parsed.prompt ?? "",
    };
  });

  return cachedTemplates;
}
