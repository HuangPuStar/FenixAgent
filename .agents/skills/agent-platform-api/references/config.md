---
name: api-config
description: RCS 配置管理 API。当需要"管理 Provider"、"配置 Model"、"修改 Agent 配置"、"管理 Skill"、"管理 MCP 服务器"、"测试连接"时使用。使用 curl + jq 调用 REST API。
allowed-tools: Bash
---

# Config API

管理 RCS 平台的五大配置模块。配置 API 使用 REST 风格；资源名称通过 `name` 查询参数或路径参数传递，操作类接口使用 `/actions/*` 子路径。

---

## 一、Provider（LLM 供应商）— `/web/config/providers`

### 列出所有 Provider

```bash
curl -s "$USER_META_BASE_URL/web/config/providers" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" | jq '.data.providers[] | { id, name, protocol }'
```

### 获取 Provider 详情（含 Model 列表）

```bash
curl -s "$USER_META_BASE_URL/web/config/providers?name=openai" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" | jq '.data | keys'
```

返回包含 `id`、`name`、`protocol`、`baseUrl`、`models` 数组等。

### 设置/更新 Provider

```bash
curl -s -X PUT "$USER_META_BASE_URL/web/config/providers?name=my-provider" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "protocol":"openai",
    "baseURL":"https://api.openai.com/v1",
    "apiKey":"sk-xxx",
    "name":"My OpenAI"
  }' | jq '.data | { id, name, protocol, keyHint }'
```

`apiKey` 支持明文或 `{env:RCS_SECRET_XXX}` 环境变量占位符。

### 测试 Provider 连接

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/providers/actions/fetch-models?name=my-provider" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' | \
  jq '.data | { models }'
```

成功时返回 `models` 数组。

### 测试特定 Model

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/providers/actions/test-model?name=my-provider" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"modelId":"gpt-4o"}' | jq '.data'
```

### 添加/更新/删除 Model

```bash
# 添加 model
curl -s -X POST "$USER_META_BASE_URL/web/config/providers/actions/models?name=my-provider" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"modelId":"gpt-4o","contextLimit":128000}' | \
  jq '{ success }'

# 更新 model
curl -s -X PUT "$USER_META_BASE_URL/web/config/providers/actions/models/gpt-4o?name=my-provider" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"contextLimit":200000}' | \
  jq '{ success }'

# 删除 model
curl -s -X DELETE "$USER_META_BASE_URL/web/config/providers/actions/models/gpt-4o?name=my-provider" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" | jq '{ success }'
```

### 删除 Provider

```bash
curl -s -X DELETE "$USER_META_BASE_URL/web/config/providers?name=my-provider" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" | jq '{ success }'
```

---

## 二、Model（全局模型设置）— `/web/config/models`

### 获取当前模型配置

```bash
curl -s "$USER_META_BASE_URL/web/config/models" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" | \
  jq '.data | { current, available: (.available | length) }'
```

返回 `{ current: { model, small_model, permission }, available: [...] }`。


---

## 三、Agent（Agent 配置）— `/web/config/agents`

### 列出所有 Agent 配置

```bash
curl -s "$USER_META_BASE_URL/web/config/agents" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" | jq '.data | { default_agent, agents: (.agents | length) }'
```

### 获取 Agent 配置详情

```bash
curl -s "$USER_META_BASE_URL/web/config/agents?name=general" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" | jq '.data'
```

### 创建 Agent 配置

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/agents" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"my-agent",
    "data":{
      "description":"自定义 Agent",
      "modelId":"<MODEL_ID>",
      "prompt":"你是一个助手"
    }
  }' | jq '.data | { name }'
```

`modelId` 必须是 `GET /web/config/models` 的 `data.available[]` 中对应模型条目的 `id`（UUID）；先在该数组按 `provider` 和 `modelId` 定位条目。

### 更新 Agent 配置

```bash
curl -s -X PUT "$USER_META_BASE_URL/web/config/agents?name=my-agent" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data":{
      "prompt":"新的系统提示",
      "modelId":"<MODEL_ID>",
      "skillIds":["<skill-id-1>","<skill-id-2>"]
    }
  }' | jq '.data | { name }'
```

`skillIds` 会全量覆盖该 Agent 绑定的 skill 列表。

### 设置默认 Agent

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/agents/default" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"general"}' | jq '.data'
```

### 删除 Agent 配置

```bash
curl -s -X DELETE "$USER_META_BASE_URL/web/config/agents?name=my-agent" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" | jq '{ success }'
```

---

## 四、Skill（技能）— `/web/config/skills`

### 列出所有 Skill

```bash
curl -s "$USER_META_BASE_URL/web/config/skills" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" | jq '.data.skills[] | { id, name, description }'
```

### 获取 Skill 详情

```bash
curl -s "$USER_META_BASE_URL/web/config/skills/agent-platform-api" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" | jq '.data | { name, description, content: (.content | length) }'
```

### 创建/更新 Skill

```bash
# 创建 skill（content 是 SKILL.md 的完整内容）
SKILL_CONTENT=$(cat << 'EOF'
---
name: my-skill
description: 我的自定义 skill
---
# My Skill
内容...
EOF
)

jq -n --arg content "$SKILL_CONTENT" --arg desc "我的自定义 skill" \
  '{name:"my-skill", data:{description:$desc, content:$content}}' | \
curl -s -X POST "$USER_META_BASE_URL/web/config/skills" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- | jq '.data | { name }'
```

### 上传 Skill 文件

```bash
MANIFEST='[{"skillName":"my-skill","relativePath":"SKILL.md"}]'

curl -s -X POST "$USER_META_BASE_URL/web/config/skills/upload" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -F "manifest=$MANIFEST" \
  -F "files=@./my-skill/SKILL.md" \
  -F "conflictStrategy=overwrite" | \
  jq '.data | { imported }'
```

`manifest` 是**文本字段**，值为 JSON 数组，不是 `manifest.json` 文件。数组每一项包含 `skillName` 和 `relativePath`；重复传入的 `files` 必须与数组严格按顺序一一对应。导入额外文件时，同时在 `manifest` 增加对应项并追加一个 `-F "files=@..."`。`conflictStrategy` 可选，取值为 `ignore` 或 `overwrite`。

### 删除 Skill

```bash
curl -s -X DELETE "$USER_META_BASE_URL/web/config/skills/my-skill" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" | jq '{ success }'
```

---

## 五、MCP Server — `/web/config/mcp`

### 列出所有 MCP 服务器

```bash
curl -s "$USER_META_BASE_URL/web/config/mcp" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" | jq '.data.servers[] | { id, name, type, enabled }'
```

### 获取 MCP 服务器配置

```bash
curl -s "$USER_META_BASE_URL/web/config/mcp?name=my-mcp" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" | jq '.data'
```

### 创建 MCP 服务器

```bash
# local stdio 类型
curl -s -X POST "$USER_META_BASE_URL/web/config/mcp" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"my-mcp",
    "config":{"type":"local","command":["npx","-y","@modelcontextprotocol/server-filesystem","/tmp"]}
  }' | jq '.data'

# remote streamable-http 类型
curl -s -X POST "$USER_META_BASE_URL/web/config/mcp" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"remote-mcp",
    "config":{"type":"remote","url":"https://mcp.example.com/sse","headers":{"Authorization":"Bearer xxx"}}
  }' | jq '.data'
```

### 启用/禁用 MCP 服务器

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/mcp/actions/enable?name=my-mcp" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" | jq '.data | { name, enabled }'
```

### 测试 MCP 服务器

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/mcp/actions/test?name=my-mcp" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" | jq '.data'
```

### 检查 MCP 工具列表

```bash
curl -s "$USER_META_BASE_URL/web/config/mcp/actions/tools?name=my-mcp" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" | \
  jq '.data.tools[] | { name, description }'
```

### 删除 MCP 服务器

```bash
curl -s -X DELETE "$USER_META_BASE_URL/web/config/mcp?name=my-mcp" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" | jq '{ success }'
```
