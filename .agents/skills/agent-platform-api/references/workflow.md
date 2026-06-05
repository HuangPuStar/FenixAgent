---
name: api-workflow
description: 工作流（Workflow）API。当需要"创建工作流"、"保存 YAML"、"发布版本"、"运行工作流"、"查看运行状态"、"管理触发器"、"看板管理"、"作业管理"时使用。使用 curl + jq 调用 REST API。
allowed-tools: Bash
---

# Workflow API

管理工作流定义、版本、执行引擎、看板和作业。所有工作流 API 使用 `POST` + JSON body `action` 字段。

---

## 一、工作流定义 — `/web/workflow-defs`

### 创建工作流

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-defs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"create","name":"my-workflow","description":"示例工作流"}' | \
  jq '.data | { id, name }'
```

### 列出所有工作流

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-defs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"list"}' | jq '.data[] | { id, name, description }'
```

### 获取工作流详情（含草稿 YAML）

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-defs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"get","workflowId":"<ID>"}' | jq -r '.data.draftYaml'
```

`draftYaml` 是当前草稿内容字符串，`null` 表示草稿为空。

### 保存草稿 YAML

```bash
# 先将 YAML 写入临时文件，再用 jq 构建 body
cat > /tmp/draft.yaml << 'EOF'
schema_version: "1"
name: my-workflow
nodes:
  - id: step1
    type: shell
    description: "第一步"
    command: echo hello
EOF

jq -n --arg yaml "$(cat /tmp/draft.yaml)" --arg wfId "<WORKFLOW_ID>" \
  '{action:"save", workflowId:$wfId, yaml:$yaml}' | \
curl -s -X POST "$USER_META_BASE_URL/web/workflow-defs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- | jq '{ success }'
```

**注意**：必须用临时文件 + jq 传递 YAML，不要手动拼 JSON。

### 发布版本

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-defs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"publish","workflowId":"<ID>"}' | \
  jq '.data | { version }'
```

### 查看版本历史

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-defs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"getVersions","workflowId":"<ID>"}' | \
  jq '.data[] | { version, status, createdAt }'
```

### 获取指定版本 YAML

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-defs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"getVersion","workflowId":"<ID>","version":1}' | \
  jq -r '.data.yaml'
```

### 回滚到指定版本

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-defs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"restoreToDraft","workflowId":"<ID>","version":1}' | jq '{ success }'
```

### 更新元信息

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-defs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"updateMeta","workflowId":"<ID>","name":"新名称","description":"新描述"}' | \
  jq '.data | { id, name }'
```

### 删除工作流

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-defs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"delete","workflowId":"<ID>"}' | jq '{ success }'
```

---

## 二、工作流执行引擎 — `/web/workflow-engine`

### 干运行（验证 YAML 结构）

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-engine" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"dryRun","workflowId":"<ID>"}' | \
  jq '.data | { valid, issues }'
```

### 运行工作流

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-engine" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"run","workflowId":"<ID>"}' | \
  jq '.data | { runId, status }'
```

可选传 `params` 对象和直接传 `yaml` 字符串。

### 查询运行状态

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-engine" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"getRunStatus","runId":"<RUN_ID>"}' | \
  jq '.data | { status, startedAt }'
```

### 获取运行事件

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-engine" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"getEvents","runId":"<RUN_ID>"}' | \
  jq '.data | length'
```

可选 `nodeId` 过滤特定节点事件。

### 获取节点输出

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-engine" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"getOutput","runId":"<RUN_ID>","nodeId":"step1"}' | \
  jq '.data'
```

### 取消运行

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-engine" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"cancel","runId":"<RUN_ID>"}' | jq '{ success }'
```

### 审批通过

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-engine" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"approve","runId":"<RUN_ID>","nodeId":"approve_1","token":"<TOKEN>"}' | \
  jq '{ success }'
```

### 查看待审批

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-engine" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"getPendingApprovals","runId":"<RUN_ID>"}' | \
  jq '.data'
```

### 列出所有运行记录

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-engine" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"listRuns"}' | \
  jq '.data[] | { runId, status, workflowId }'
```

可选 `workflowId` 过滤。

### 从指定节点重跑

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-engine" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"rerunFrom","runId":"<RUN_ID>","fromNodeId":"step2","workflowId":"<ID>"}' | \
  jq '.data | { runId, status }'
```

---

## 三、触发器 — `/web/workflow-defs` (action 内)

### 创建触发器

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-defs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"createTrigger","workflowId":"<ID>","type":"webhook"}' | \
  jq '.data'
```

### 列出触发器

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-defs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"listTriggers","workflowId":"<ID>"}' | jq '.data'
```

### 启用/禁用触发器

```bash
# 启用
curl -s -X POST "$USER_META_BASE_URL/web/workflow-defs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"enableTrigger","triggerId":"<TRIGGER_ID>"}' | jq '{ success }'

# 禁用
curl -s -X POST "$USER_META_BASE_URL/web/workflow-defs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"disableTrigger","triggerId":"<TRIGGER_ID>"}' | jq '{ success }'
```

### 删除触发器 / 重新生成 Hash

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-defs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"deleteTrigger","triggerId":"<ID>"}' | jq '{ success }'
```

---

## 四、看板 — `/web/workflow-boards`

所有看板 API 使用 `POST` + `action` 字段。

### 列出看板

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-boards" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"list"}' | jq '.data[] | { id, name }'
```

### 创建看板

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-boards" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"create","name":"我的看板"}' | jq '.data'
```

---

## 五、作业 — `/web/workflow-jobs`

所有作业 API 使用 `POST` + `action` 字段。

### 创建作业

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-jobs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"create","workflowId":"<WF_ID>","boardId":"<BOARD_ID>","params":{"key":"value"}}' | \
  jq '.data | { id, status }'
```

### 列出作业

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-jobs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"list","boardId":"<可选>"}' | \
  jq '.data[] | { id, status }'
```

### 运行作业

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-jobs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"run","jobId":"<JOB_ID>"}' | \
  jq '.data | { runId }'
```

### 取消作业

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-jobs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"cancel","jobId":"<JOB_ID>"}' | jq '{ success }'
```

### 获取作业输出

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-jobs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"getOutputs","jobId":"<JOB_ID>"}' | jq '.data'
```

### 作业审批

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-jobs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"approve","jobId":"<JOB_ID>","nodeId":"approve_1","token":"<TOKEN>"}' | \
  jq '{ success }'
```
