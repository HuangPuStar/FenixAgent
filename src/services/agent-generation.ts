import OpenAI from "openai";
import type { AuthContext } from "../plugins/auth";
import { listSkills } from "./config/skill";

/** Skill 条目（前端用 name + description 展示，用 id 提交） */
export interface SkillItem {
  id: string;
  name: string;
  description: string;
}

/** Agent 智能生成结果 */
export interface AgentGenerationResult {
  name: string;
  systemPrompt: string;
  skills: SkillItem[];
}

/** 检查生成功能是否已配置（依赖标准 OpenAI 环境变量） */
export function isGenerationConfigured(): boolean {
  return !!(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL);
}

/** 调用 LLM 生成 Agent 配置 */
export async function generateAgentConfig(ctx: AuthContext, prompt: string): Promise<AgentGenerationResult> {
  if (!isGenerationConfigured()) {
    throw new Error("NOT_CONFIGURED");
  }

  // 查询当前组织所有可用 skills
  const skills = await listSkills(ctx);
  const skillList = skills.map((s) => `- ${s.name}: ${s.description ?? ""}`).join("\n");

  const systemPrompt = `你是一个智能体配置生成助手。根据用户的需求描述，生成智能体的配置信息。

你需要返回一个 JSON 对象，包含以下字段：
- name: 智能体的名称，必须是中文（如"周报助手"、"代码审查专家"、"PPT大纲生成器"）。禁止使用英文，禁止使用 kebab-case 或 snake_case，禁止包含连字符
- systemPrompt: 智能体的系统提示词，详细描述智能体的角色和行为
- skills: 推荐启用的技能名称数组，从下面的可用技能列表中选择

示例输出：
{"name": "周报助手", "systemPrompt": "你是一个周报撰写助手...", "skills": ["skill-name"]}

可用技能列表：
${skillList || "（暂无可用技能）"}

请只返回 JSON，不要包含其他内容。`;

  // 使用标准 OpenAI SDK 环境变量：OPENAI_API_KEY、OPENAI_BASE_URL
  const client = new OpenAI();

  const response = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL!,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("PARSE_ERROR");
  }

  let parsed: { name?: string; systemPrompt?: string; skills?: string[] };
  try {
    parsed = JSON.parse(content) as { name?: string; systemPrompt?: string; skills?: string[] };
  } catch (err) {
    console.error("[agent-generation] Failed to parse LLM response:", err);
    throw new Error("PARSE_ERROR");
  }

  if (!parsed.name || !parsed.systemPrompt) {
    throw new Error("PARSE_ERROR");
  }

  // 将 LLM 返回的 skill 名称映射为 { id, name, description } 对象，前端用 name + description 展示、id 提交
  const skillNameToInfo = new Map(
    skills.map((s) => [s.name.toLowerCase(), { id: s.id, name: s.name, description: s.description ?? "" }]),
  );
  const mappedSkills = (parsed.skills ?? [])
    .map((name: string) => skillNameToInfo.get(name.toLowerCase()))
    .filter((item): item is SkillItem => !!item);

  return {
    name: parsed.name,
    systemPrompt: parsed.systemPrompt,
    skills: mappedSkills,
  };
}
