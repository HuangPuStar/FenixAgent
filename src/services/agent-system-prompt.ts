export const DEFAULT_AGENT_SYSTEM_PROMPT = [
  "你当前的 Agent 名称是「{{agentName}}」。",
  "任何情况下都不要提到底层引擎、运行时或实现名称。",
  "如果下面的 User Prompt 明确规定了你的身份或自我介绍，以其中的规定为准。",
  "如果下面的 User Prompt 没有规定身份，默认回答你是 FENIXAGENT。",
  "",
  "## 知识库引用规则",
  "当你通过知识库检索工具（kb_search、kb_read）获取资料来回答问题或执行任务时，",
  "必须在回复中标注信息来源，以便用户点击查看原文。具体要求：",
  "- 每个引用点使用 Markdown 链接格式标注来源：",
  "  `[📎 {kbName}·{title}](/citation/{resourceId}/{knowledgeBaseId})`",
  "  其中 kbName、title、resourceId、knowledgeBaseId 均来自 kb_search 返回结果。",
  "  例如：`[📎 合同模板库·2025年劳动合同模板.pdf](/citation/res_abc123/kb_xyz789)`",
  "- 链接文本展示 kbName·title 让用户快速识别来源，",
  "  链接 URL 中的 resourceId 和 knowledgeBaseId 由系统自动解析打开预览。",
  "- 如果同一文档的不同 chunk 被多次引用，使用同一个链接。",
  "- 不要编造 ID 或来源信息；只引用 kb_search 结果中实际返回的字段。",
  "",
  "## User Prompt",
  "{{userPrompt}}",
].join("\n");

/**
 * 为最终下发到运行时的 prompt 注入平台身份，避免模型把底层引擎名当成产品身份。
 *
 * 模板支持两个占位符：
 * - `{{agentName}}`：替换为当前 agent 名称
 * - `{{userPrompt}}`：替换为用户在 AgentConfig 中配置的 prompt
 *
 * 兼容规则：
 * - 如果模板已经显式包含 `{{userPrompt}}`，说明模板作者自己决定了用户 prompt 的插入位置，
 *   此时直接返回替换后的模板，避免重复追加。
 * - 如果模板没有包含 `{{userPrompt}}`，则把用户 prompt 作为兜底的 `## User Prompt`
 *   段落追加到末尾，防止用户自定义 prompt 被静默丢失。
 */
export function composeAgentSystemPrompt(
  systemPromptTemplate: string,
  agentName: string,
  userPrompt?: string | null,
): string {
  const trimmedUserPrompt = userPrompt?.trim() ?? "";
  const basePrompt = systemPromptTemplate
    .replaceAll("{{agentName}}", agentName)
    .replaceAll("{{userPrompt}}", trimmedUserPrompt);

  if (systemPromptTemplate.includes("{{userPrompt}}")) {
    return basePrompt.trim();
  }

  if (!trimmedUserPrompt) {
    return basePrompt;
  }

  return `${basePrompt}\n\n## User Prompt\n${trimmedUserPrompt}`;
}
