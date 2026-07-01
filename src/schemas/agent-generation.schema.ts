import * as z from "zod/v4";
import { WebOkSchema } from "./common.schema";

/** Agent 智能生成返回的推荐 Skill 项。 */
export const AgentGenerationSkillSchema = z.object({
  id: z.string().describe("Skill ID。"),
  name: z.string().describe("Skill 名称。"),
  description: z.string().describe("Skill 描述。"),
});

/** Agent 智能生成成功响应中的 data 结构。 */
export const AgentGenerationResultSchema = z.object({
  name: z.string().describe("生成的 Agent 名称。"),
  systemPrompt: z.string().describe("生成的 Agent 系统提示词。"),
  skills: z.array(AgentGenerationSkillSchema).describe("推荐启用的 Skill 列表。"),
});

/** Agent 智能生成成功响应。 */
export const AgentGenerationResponseSchema = WebOkSchema(AgentGenerationResultSchema);

export type AgentGenerationSkill = z.infer<typeof AgentGenerationSkillSchema>;
export type AgentGenerationResult = z.infer<typeof AgentGenerationResultSchema>;
export type AgentGenerationResponse = z.infer<typeof AgentGenerationResponseSchema>;
