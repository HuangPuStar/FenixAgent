export type AgentEditorSectionId =
  | "identity"
  | "model"
  | "capabilities"
  | "knowledge"
  | "runtime"
  | "sharing"
  | "advanced";

export interface AgentEditorDraft {
  name: string;
  slug: string;
  description: string;
  modelId: string;
  prompt: string;
  templateId: string | null;
  skillIds: string[];
  mcpIds: string[];
  siteIds: string[];
  knowledgeBaseIds: string[];
  searchFirst: boolean;
  maxResults: number;
  enableMemory: boolean;
  nodeId: string;
  publicReadable: boolean;
  extra: string;
}

export interface EditorOption {
  id: string;
  name: string;
  description: string;
  meta?: string;
}

export const INITIAL_AGENT_DRAFT: AgentEditorDraft = {
  name: "公文写手",
  slug: "agent-gov-writer",
  description: "根据政策资料起草、改写和审校公文，确保格式规范、依据准确。",
  modelId: "claude-sonnet-4-5",
  prompt:
    "你是一名熟悉党政机关公文规范的写作顾问。\n\n工作时先检索已绑定的政策与写作规范，确认文种、受众和发文目的；信息不足时主动提问，不得编造政策依据。输出应结构清晰、语言克制，并标注需要人工确认的事实。",
  templateId: null,
  skillIds: ["policy-search", "official-writing", "document-review"],
  mcpIds: ["filesystem", "web-search"],
  siteIds: ["official-doc-center"],
  knowledgeBaseIds: ["policy-library", "writing-standard"],
  searchFirst: true,
  maxResults: 6,
  enableMemory: true,
  nodeId: "sandbox:gz-production",
  publicReadable: true,
  extra: '{\n  "output": {\n    "defaultFormat": "markdown",\n    "citeSources": true\n  }\n}',
};

export const MODEL_OPTIONS: EditorOption[] = [
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", description: "Anthropic", meta: "200K 上下文" },
  { id: "gpt-5-2", name: "GPT-5.2", description: "OpenAI", meta: "400K 上下文" },
  { id: "nova-4-1", name: "Nova 4.1", description: "AWS Bedrock", meta: "256K 上下文" },
  { id: "qwen3-max", name: "Qwen3 Max", description: "阿里云百炼", meta: "128K 上下文" },
];

export const SKILL_OPTIONS: EditorOption[] = [
  { id: "policy-search", name: "政策检索", description: "从可信政策来源中定位依据", meta: "组织共享" },
  { id: "official-writing", name: "公文写作", description: "按法定文种组织结构与措辞", meta: "已验证" },
  { id: "document-review", name: "文档审校", description: "检查格式、事实和行文一致性", meta: "已验证" },
  { id: "table-extractor", name: "表格提取", description: "识别附件中的结构化表格", meta: "个人" },
  { id: "translation", name: "正式文本翻译", description: "保持术语一致的中英互译", meta: "组织共享" },
];

export const MCP_OPTIONS: EditorOption[] = [
  { id: "filesystem", name: "工作区文件", description: "读取和写入当前智能体工作区", meta: "最小权限" },
  { id: "web-search", name: "可信网页检索", description: "检索公开网页并保留来源", meta: "只读" },
  { id: "postgres", name: "业务数据查询", description: "查询已授权的 PostgreSQL 视图", meta: "只读" },
  { id: "feishu", name: "飞书协作", description: "读取文档并发送审批消息", meta: "需授权" },
];

export const SITE_OPTIONS: EditorOption[] = [
  { id: "official-doc-center", name: "公文工作台", description: "预览和交付生成的正式文稿", meta: "已部署" },
  { id: "policy-radar", name: "政策雷达", description: "展示政策更新与影响摘要", meta: "已部署" },
  { id: "review-console", name: "审校控制台", description: "集中处理人工复核事项", meta: "草稿" },
];

export const KNOWLEDGE_OPTIONS: EditorOption[] = [
  { id: "policy-library", name: "政策法规库", description: "国家及省市现行政策文件", meta: "8,420 篇 · 今日同步" },
  { id: "writing-standard", name: "公文规范库", description: "文种、格式与常用表述规范", meta: "386 篇 · 已就绪" },
  {
    id: "organization-terms",
    name: "机构术语库",
    description: "组织名称、专有术语和历史口径",
    meta: "1,204 条 · 已就绪",
  },
  { id: "excellent-cases", name: "优秀案例库", description: "经审核的历史公文参考案例", meta: "642 篇 · 已就绪" },
];

export const NODE_OPTIONS: EditorOption[] = [
  { id: "default", name: "本地默认", description: "由平台自动选择本机运行环境", meta: "就绪" },
  {
    id: "sandbox:gz-production",
    name: "广州生产沙盒池",
    description: "隔离执行，适合文件与浏览器工具",
    meta: "12 / 20 可用",
  },
  { id: "sandbox:sh-burst", name: "上海弹性沙盒池", description: "高峰期自动扩容的临时执行环境", meta: "8 / 40 可用" },
  {
    id: "machine:design-mac",
    name: "设计组 Mac Studio",
    description: "固定机器，保留本地专用依赖",
    meta: "在线 · 24 ms",
  },
];

export const TEMPLATE_OPTIONS = [
  {
    id: "policy-brief",
    name: "政策简报",
    description: "提炼政策变化、影响范围和待办事项",
    prompt:
      "你是政策研究顾问。先从绑定知识库检索最新依据，再按“变化—影响—建议”输出简报。所有结论必须附来源，无法确认的内容明确标记。",
    skillIds: ["policy-search", "official-writing"],
  },
  {
    id: "document-review",
    name: "公文审校",
    description: "逐项检查格式、措辞、数字与政策依据",
    prompt:
      "你是严谨的公文审校员。依次检查文种、版式、结构、称谓、数字、日期与政策引用，按严重程度列出问题，并给出最小修改建议。",
    skillIds: ["document-review", "policy-search"],
  },
  {
    id: "meeting-summary",
    name: "会议纪要",
    description: "从会议材料形成可追踪的决议与任务",
    prompt: "你负责整理正式会议纪要。区分事实、决议与待办，逐项保留负责人和截止日期；存在冲突或缺失时先列出待确认项。",
    skillIds: ["official-writing", "table-extractor"],
  },
];

export function cloneInitialAgentDraft(): AgentEditorDraft {
  return {
    ...INITIAL_AGENT_DRAFT,
    skillIds: [...INITIAL_AGENT_DRAFT.skillIds],
    mcpIds: [...INITIAL_AGENT_DRAFT.mcpIds],
    siteIds: [...INITIAL_AGENT_DRAFT.siteIds],
    knowledgeBaseIds: [...INITIAL_AGENT_DRAFT.knowledgeBaseIds],
  };
}
