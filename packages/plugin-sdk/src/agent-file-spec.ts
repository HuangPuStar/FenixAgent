/**
 * agent-file-spec.ts — Subagent 文件规格（AgentFileSpec）与 Markdown 渲染。
 *
 * AgentFileSpec 是专家库（agent_expert 行）与引擎可消费的 `.agents/agents/{name}.md` /
 * `.claude/agents/{name}.md` 文件之间的契约：字段与 agent_expert 表列一一对应，
 * 与内置模板解析器（src/services/agent-templates.ts 的 frontmatter 语义）同构，
 * 防止 DB 存储与渲染文件之间的格式漂移（设计文档 §4）。
 *
 * 渲染端不依赖 gray-matter（那是解析器）；frontmatter 序列化采用 YAML 兼容
 * JSON 标量转义（js-yaml 是 JSON 超集，gray-matter 可解析），避免手写 YAML
 * 转义引入注入风险（如 name 含 `: `、引号或控制字符）。
 */

/**
 * 专家（subagent）文件规格。与 agent_expert 表可写列一一对应；
 * 可选字段缺省时不写入 frontmatter（保持与模板解析器的 undefined 语义一致）。
 */
export interface AgentFileSpec {
  /** 专家名称，与渲染文件名对应（引擎按文件名发现 agent） */
  name: string;
  /** 描述（frontmatter description，可选） */
  description?: string;
  /** md 正文（subagent 系统提示词） */
  prompt: string;
  /** skill 名称列表（与 frontmatter skills 同构，引擎按名称消费） */
  skills?: string[];
  /** 默认模型业务标识 providerName/modelId（可选） */
  model?: string;
  /** primary | subagent | all */
  mode?: string;
  temperature?: number;
  steps?: number;
  /** ask/allow/deny 规则（预留，透传对象） */
  permission?: unknown;
}

/** YAML 标量安全序列化：JSON 字符串是合法 YAML 标量（js-yaml 兼容），避免手写转义 */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** 仅写入非 undefined 字段，保持文件最小化且与模板解析器缺省语义一致 */
function pushDefined(lines: string[], key: string, value: unknown): void {
  if (value === undefined) return;
  lines.push(`${key}: ${JSON.stringify(value)}`);
}

/**
 * 渲染专家 md 文件内容（frontmatter + 正文）。
 *
 * 输出可被 gray-matter 原样解析回 AgentFileSpec 等价结构；
 * 引擎（opencode/ccb/claude-code）按各自目录约定落盘消费。
 */
export function renderAgentFileMarkdown(spec: AgentFileSpec): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${yamlString(spec.name)}`);
  pushDefined(lines, "description", spec.description);
  pushDefined(lines, "skills", spec.skills);
  pushDefined(lines, "model", spec.model);
  pushDefined(lines, "mode", spec.mode);
  pushDefined(lines, "temperature", spec.temperature);
  pushDefined(lines, "steps", spec.steps);
  if (spec.permission !== undefined) {
    pushDefined(lines, "permission", spec.permission);
  }
  lines.push("---");
  // 正文规范化：与模板解析器一致（trim），保证 round-trip 稳定
  const body = spec.prompt.trim();
  if (body.length > 0) {
    lines.push("", body);
  }
  return `${lines.join("\n")}\n`;
}
