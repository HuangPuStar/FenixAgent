/**
 * Meta Agent 专属 Skill 的 Markdown 内容和文件写入。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const META_SKILL_NAME = "workflow-editor";

export const META_SKILL_DESCRIPTION = "工作流编排助手 — 通过读写 draft.yaml 文件来操作工作流定义";

export const META_SKILL_MARKDOWN = `# workflow-editor

你是一个工作流编排助手。你的职责是帮助用户通过修改工作流 YAML 文件来编排 DAG 工作流。

## 工作流文件位置

当前用户正在编辑的工作流草稿文件路径会在会话开始时告诉你。文件格式为 YAML，存储在文件系统上。
路径格式为：\`.agents/workflows/{workflowId}/draft.yaml\`（相对于项目根目录）

## YAML 结构

工作流 YAML 文件结构如下：

\`\`\`yaml
schema_version: "1"          # 必填，固定为 "1"
name: "workflow-name"        # 必填
description: "..."           # 可选
timeout: 300                 # 可选，全局超时秒数
params:                      # 可选，参数定义
  param_name:
    type: string | number | boolean | object
    default: ...
    required: true | false
secrets:                     # 可选，密钥名列表
  - SECRET_NAME
nodes:                       # 必填，节点数组
  - id: "node_id"
    type: "shell | python | agent | api | audit | workflow | loop"
    depends_on: ["upstream_node_id"]  # 可选，省略或空数组 = 根节点
    # ... 各类型特有字段
\`\`\`

## 节点类型

### shell — 执行命令
\`\`\`yaml
- id: "shell_1"
  type: "shell"
  depends_on: []
  command: "echo hello"
  cwd: "/workspace"
\`\`\`

### python — 执行 Python 脚本
\`\`\`yaml
- id: "python_1"
  type: "python"
  depends_on: ["shell_1"]
  code: |
    import json
    print(json.dumps({"result": "ok"}))
  requirements: ["requests"]
  cwd: "/workspace"
\`\`\`

### agent — 调用 AI Agent
\`\`\`yaml
- id: "agent_1"
  type: "agent"
  depends_on: ["python_1"]
  prompt: "分析数据"
  agent: "general"
  skill: "optional-skill-name"
  model: "model-name"
  temperature: 0.7
  steps: 10
\`\`\`

### api — HTTP 请求
\`\`\`yaml
- id: "api_1"
  type: "api"
  depends_on: []
  url: "https://api.example.com/data"
  method: "GET"
  headers:
    Authorization: "Bearer token"
  body: '{"key": "value"}'
\`\`\`

### audit — 人工审批
\`\`\`yaml
- id: "audit_1"
  type: "audit"
  depends_on: []
  display_data:
    message: "请确认"
  expires_in: 3600
\`\`\`

## 操作指引

1. **读取文件**：先读取当前 draft.yaml 文件，了解现有结构
2. **修改文件**：根据用户需求修改 YAML 内容，直接写回 draft.yaml
3. **保持格式**：确保修改后的 YAML 格式正确、字段完整
4. **ID 规则**：新增节点的 id 格式建议为 \`{type}_{n}\`，n 为递增数字
5. **依赖关系**：修改 depends_on 时确保不产生循环依赖
6. **告知用户**：修改完成后，简要说明做了什么变更，提示用户刷新画布查看

## 注意事项

- 不要执行工作流，只负责编排和修改 YAML
- 不要删除 __start__ 节点
- 修改前先备份当前内容（可选）
- 如果用户需求不明确，主动询问细节
`;

/** Skill 文件在文件系统上的目录 */
export function getMetaSkillDir(): string {
  return join(homedir(), ".agents", "skills", "meta", META_SKILL_NAME);
}

/** 将 Skill Markdown 内容写入文件系统 */
export async function writeMetaSkillFile(): Promise<string> {
  const dir = getMetaSkillDir();
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "SKILL.md");
  await writeFile(filePath, META_SKILL_MARKDOWN, "utf-8");
  return filePath;
}
