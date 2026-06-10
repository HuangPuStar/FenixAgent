import OpenAI from "openai";
import type { AuthContext } from "../plugins/auth";
import { listSkills } from "./config/skill";

/** Agent 智能生成结果 */
export interface AgentGenerationResult {
  name: string;
  systemPrompt: string;
  skills: string[];
}

/** 检查生成功能是否已配置 */
export function isGenerationConfigured(): boolean {
  return !!(
    process.env.RCS_GENERATION_MODEL_ENDPOINT &&
    process.env.RCS_GENERATION_MODEL_KEY &&
    process.env.RCS_GENERATION_MODEL_NAME
  );
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
- name: 智能体的英文名称，使用 kebab-case 格式（如 weekly-report-assistant），1-64字符
- systemPrompt: 智能体的系统提示词，详细描述智能体的角色和行为
- skills: 推荐启用的技能名称数组，从下面的可用技能列表中选择

可用技能列表：
${skillList || "（暂无可用技能）"}

请只返回 JSON，不要包含其他内容。`;

  const client = new OpenAI({
    apiKey: process.env.RCS_GENERATION_MODEL_KEY,
    baseURL: process.env.RCS_GENERATION_MODEL_ENDPOINT,
  });

  const response = await client.chat.completions.create({
    model: process.env.RCS_GENERATION_MODEL_NAME!,
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
  } catch {
    throw new Error("PARSE_ERROR");
  }

  if (!parsed.name || !parsed.systemPrompt) {
    throw new Error("PARSE_ERROR");
  }

  // 将 LLM 返回的 skill 名称映射为真实 skill ID
  const skillNameToId = new Map(skills.map((s) => [s.name.toLowerCase(), s.id ?? s.name]));
  const mappedSkills = (parsed.skills ?? [])
    .map((name: string) => skillNameToId.get(name.toLowerCase()))
    .filter((id): id is string => !!id);

  return {
    name: parsed.name,
    systemPrompt: parsed.systemPrompt,
    skills: mappedSkills,
  };
}
