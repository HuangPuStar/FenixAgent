# FenixAgent

**FenixAgent** 是一个 AI Agent 控制面板，用来管理模型、Agent、工作流和会话。

## 功能导航

<div class="grid-cards">

**[🔧 大模型配置](./models/)**

配置 OpenAI、Anthropic、阿里云等 AI 服务商和模型。

---

**[🤖 Agent 管理](./agents/)**

创建和管理智能体实例，配置角色、权限和行为。

---

**[⏰ 定时任务](./scheduled-tasks/)**

创建周期性任务，支持 cron 表达式和失败重试。

---

**[📦 Skills](./skills/)**

管理自定义技能模块，扩展 Agent 能力。

---

**[🔌 MCP](./mcp/)**

配置 Model Context Protocol 服务器，集成外部工具。

---

**[📚 知识库](./knowledge-base/)**

上传和管理文档、代码等知识资源，支持 Agent 检索。

---

**[🔄 智能体编排](./workflow/)**

可视化编排多个 Agent，构建复杂的工作流程。

---

**[🔧 故障排查](./troubleshooting/)**

解决安装、配置和使用过程中的常见问题。

</div>

## 常用概念

| 术语 | 说明 |
|------|------|
| **FenixAgent** | Fenix Agent，AI Agent 控制面板 |
| **ACP** | Agent Control Protocol，Agent 控制协议 |
| **acp-link** | 连接 Agent 和 FenixAgent |
| **Provider** | AI 服务商，如 OpenAI、Anthropic、阿里云通义千问等 |
| **Model** | AI 模型配置，定义使用哪个服务商的哪个模型（如 GPT-4、Claude 3.5） |
| **Agent** | AI 智能体，具有特定角色、提示词和权限配置的 AI 实例 |
| **Skill** | Agent 可调用的技能模块，可复用的代码片段或工具 |
| **MCP** | Model Context Protocol，模型上下文协议，用于扩展 AI 能力 |
| **Session** | 会话，与 Agent 的一次完整对话交互 |
| **Environment** | 运行环境，包含 acp-link 实例的注册信息和连接状态 |
| **API Key** | API 密钥，用于认证访问外部 AI 服务 |
| **Channel** | 频道，支持多路通信的隔离通道 |
