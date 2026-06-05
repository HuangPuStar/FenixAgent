---
name: api-config
description: RCS 配置管理 API。当需要"管理 Provider"、"配置 Model"、"修改 Agent 配置"、"管理 Skill"、"管理 MCP 服务器"、"测试连接"时使用。使用 curl + jq 调用 REST API。
allowed-tools: Bash
---

# Config API

管理 RCS 平台的五大配置模块。所有配置 API 使用 `POST /web/config/:module` + JSON body `action` 字段。

---

## 一、Provider（LLM 供应商）— `/web/config/providers`

### 列出所有 Provider

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/providers" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"list"}' | jq '.data.providers[] | { id, name, displayName, protocol }'
```

### 获取 Provider 详情（含 Model 列表）

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/providers" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"get","name":"openai"}' | jq '.data | keys'
```

返回包含 `id`、`name`、`protocol`、`baseUrl`、`models` 数组等。

### 设置/更新 Provider

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/providers" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "action":"set",
    "name":"my-provider",
    "data":{
      "protocol":"openai",
      "baseUrl":"https://api.openai.com/v1",
      "apiKey":"sk-xxx",
      "displayName":"My OpenAI"
    }
  }' | jq '.data | { id, name, protocol, keyHint }'
```

`apiKey` 支持明文或 `{env:RCS_SECRET_XXX}` 环境变量占位符。

### 测试 Provider 连接

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/providers" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"test","name":"my-provider"}' | \
  jq '.data | { ok, models }'
```

返回 `ok: true/false`，成功时附带 `models` 数组。

### 测试特定 Model

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/providers" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"test_model","name":"my-provider","modelId":"gpt-4o"}' | jq '.data'
```

### 添加/更新/删除 Model

```bash
# 添加 model
curl -s -X POST "$USER_META_BASE_URL/web/config/providers" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"add_model","name":"my-provider","data":{"modelId":"gpt-4o","contextLength":128000}}' | \
  jq '{ success }'

# 更新 model
curl -s -X POST "$USER_META_BASE_URL/web/config/providers" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"update_model","name":"my-provider","modelId":"gpt-4o","data":{"contextLength":200000}}' | \
  jq '{ success }'

# 删除 model
curl -s -X POST "$USER_META_BASE_URL/web/config/providers" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"remove_model","name":"my-provider","modelId":"gpt-4o"}' | jq '{ success }'
```

### 删除 Provider

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/providers" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"delete","name":"my-provider"}' | jq '{ success }'
```

---

## 二、Model（全局模型设置）— `/web/config/models`

### 获取当前模型配置

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/models" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"get"}' | \
  jq '.data | { current, available: (.available | length) }'
```

返回 `{ current: { model, small_model, permission }, available: [...] }`。

### 设置默认模型

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/models" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"set","data":{"model":"my-provider/gpt-4o","small_model":"my-provider/gpt-4o-mini"}}' | \
  jq '.data'
```

### 刷新可用模型列表

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/models" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"refresh"}' | jq '.data | { count }'
```

---

## 三、Agent（Agent 配置）— `/web/config/agents`

### 列出所有 Agent 配置

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/agents" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"list"}' | jq '.data | { default_agent, agents: (.agents | length) }'
```

### 获取 Agent 配置详情

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/agents" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"get","name":"general"}' | jq '.data'
```

### 创建 Agent 配置

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/agents" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "action":"create",
    "name":"my-agent",
    "data":{
      "description":"自定义 Agent",
      "model":"my-provider/gpt-4o",
      "prompt":"你是一个助手",
      "steps":10
    }
  }' | jq '.data | { name }'
```

### 更新 Agent 配置

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/agents" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "action":"set",
    "name":"my-agent",
    "data":{
      "prompt":"新的系统提示",
      "model":"my-provider/gpt-4o",
      "skillIds":["<skill-id-1>","<skill-id-2>"]
    }
  }' | jq '.data | { name }'
```

`skillIds` 会全量覆盖该 Agent 绑定的 skill 列表。

### 设置默认 Agent

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/agents" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"set-default","name":"general"}' | jq '.data'
```

### 删除 Agent 配置

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/agents" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"delete","name":"my-agent"}' | jq '{ success }'
```

---

## 四、Skill（技能）— `/web/config/skills`

### 列出所有 Skill

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/skills" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"list"}' | jq '.data.skills[] | { id, name, description }'
```

### 获取 Skill 详情

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/skills" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"get","name":"agent-platform-api"}' | jq '.data | { name, description, content: (.content | length) }'
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
  '{action:"set", name:"my-skill", data:{description:$desc, content:$content}}' | \
curl -s -X POST "$USER_META_BASE_URL/web/config/skills" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- | jq '.data | { name }'
```

### 上传 Skill 文件

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/skills/upload" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -F "files=@./my-skill/SKILL.md" \
  -F "manifest=@./my-skill/manifest.json" | \
  jq '.data | { imported }'
```

### 删除 Skill

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/skills" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"delete","name":"my-skill"}' | jq '{ success }'
```

---

## 五、MCP Server — `/web/config/mcp`

### 列出所有 MCP 服务器

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/mcp" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"list"}' | jq '.data.servers[] | { id, name, type, enabled }'
```

### 获取 MCP 服务器配置

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/mcp" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"get","name":"my-mcp"}' | jq '.data'
```

### 创建 MCP 服务器

```bash
# local stdio 类型
curl -s -X POST "$USER_META_BASE_URL/web/config/mcp" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "action":"create",
    "name":"my-mcp",
    "config":{"type":"local","command":["npx","-y","@modelcontextprotocol/server-filesystem","/tmp"]}
  }' | jq '.data'

# remote streamable-http 类型
curl -s -X POST "$USER_META_BASE_URL/web/config/mcp" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "action":"create",
    "name":"remote-mcp",
    "config":{"type":"remote","url":"https://mcp.example.com/sse","headers":{"Authorization":"Bearer xxx"}}
  }' | jq '.data'
```

### 启用/禁用 MCP 服务器

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/mcp" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"enable","name":"my-mcp"}' | jq '.data | { name, enabled }'
```

### 测试 MCP 服务器

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/mcp" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"test","name":"my-mcp"}' | jq '.data'
```

### 检查 MCP 工具列表

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/mcp" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"list_tools","name":"my-mcp"}' | \
  jq '.data.tools[] | { name, description }'
```

### 删除 MCP 服务器

```bash
curl -s -X POST "$USER_META_BASE_URL/web/config/mcp" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"delete","name":"my-mcp"}' | jq '{ success }'
```
