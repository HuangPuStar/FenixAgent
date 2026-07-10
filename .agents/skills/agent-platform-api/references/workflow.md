---
name: api-workflow
description: 工作流（Workflow）API。当需要"创建工作流"、"保存 YAML"、"发布版本"、"运行工作流"、"查看运行状态"、"管理触发器"、"看板管理"、"作业管理"时使用。使用 curl + jq 调用 REST API。
allowed-tools: Bash
---

# Workflow API

管理工作流定义、版本、执行引擎、看板和作业。控制台 `/web/workflow-*` API 使用 `POST` + JSON body `action` 字段；外部执行 API 使用 `/api/workflows/:workflowId/execute` REST 端点。

---

## 〇、Agent 操作工作流的标准流程

Agent 操作工作流时，遵循 **拉取 → 编辑本地 → 校验 → 保存 → 验证** 的循环。

> **工作目录约定**：所有工作流副本一律存放在当前 env 工作目录下的 `./workflow/` 中。**禁止使用 `/tmp` 等系统临时目录**。首次使用前执行 `mkdir -p ./workflow`。

### 新建工作流流程

```
1. 创建空工作流定义 → 获得 workflowId
2. 将 YAML 写入本地文件 ./workflow/<workflowId>.yaml
3. 用 dryRun 接口校验 YAML 合法性
4. 校验通过后 save 草稿
5. 保存后用 workflowId 方式再次 dryRun，确认 engine 读到最新内容
6. 发布版本（可选）
```

### 修改已有工作流流程

```
1. 用 get 接口拉取最新草稿 YAML 到本地 ./workflow/<workflowId>.yaml
2. 在本地编辑 YAML
3. 用 dryRun 校验
4. 校验通过后 save 回服务端
5. 保存后用 workflowId 方式再次 dryRun，确认 engine 读到最新内容
6. 发布新版本（可选）
```

**核心原则**：
- **每次操作前先拉取最新数据**到本地，避免覆盖他人修改
- **必须先通过 dryRun 校验再保存**，确保 YAML 语法和 DAG 结构正确
- **保存后必须用 workflowId 方式再次 dryRun**，确认服务端持久化的内容与本地一致
- 使用本地文件 `./workflow/<workflowId>.yaml` 作为 Agent 的"工作副本"，**不要使用 `/tmp` 等系统临时目录**
- 用 `jq -n --arg yaml "$(cat ./workflow/<id>.yaml)"` 传递 YAML 内容，不要手动拼 JSON

> ⚠️ **dryRun 局限性**：dryRun 只校验 YAML 语法合法性、节点 ID 唯一性、DAG 环检测、依赖引用存在性。**不校验运行时语义**——例如 `nodes.xxx.output.stdout` 引用的上游节点在运行时是否真正有对应字段、`params.xxx` 是否因拼写错误指向不存在的参数。因此 dryRun 通过不代表工作流一定能成功运行。涉及数据传递的 YAML 建议从 `inputs-e2e.test.ts` 等 E2E 测试中确认引用路径格式。

### 版本管理策略

工作流有两种存储形态：**草稿（draft）** 和 **已发布版本（published version）**。

| | 草稿 | 已发布版本 |
|---|---|---|
| 用途 | 开发中的临时内容，反复迭代 | 稳定快照，供触发器和作业引用 |
| 修改 | 随时 save 覆盖，不产生历史 | 每次 publish 产生新版本号（只增） |
| 运行 | `/web/workflow-engine` 的 `run` 可直接用草稿运行 | 外部 `/api/workflows/:workflowId/execute` 默认执行 latestVersion，也可指定 `version` |
| 回滚 | 可通过 restoreToDraft 从历史版本回退到草稿 | 不可直接修改已发布版本 |

**操作决策指南**：

```
用户说"帮我写个工作流" / "修改一下 YAML" / "试试这个效果"
  → save 草稿 → dryRun → run 测试（传 `version: 0` 或直接传 yaml 参数执行草稿）
  → 满意后 → publish 发布版本
  → 外部系统用 /api/workflows/:workflowId/execute 执行已发布版本

用户说"把这个工作流挂到触发器上" / "给作业用"
  → 确保草稿已是最新 → publish 发布版本
  → 触发器/作业绑定到该版本
  → 需要稳定外部调用时，execute 请求中显式传 `version`，避免 latestVersion 后续变更影响结果

用户说"回退到之前的版本" / "上次的版本好用"
  → getVersions 查看历史 → restoreToDraft 回退到草稿
```

**意图确认原则**（避免误解用户操作）：

- 用户在**已有工作流上下文**中说"新建/创建"，应先确认：是修改当前工作流的 YAML，还是另建一个全新的工作流定义？
- 用户在提及某个工作流名称后说"改一下""加个节点"，默认理解为**修改该工作流的草稿**，而非新建。
- 不确定时，先列出用户最近操作的工作流，询问具体目标，再执行。

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

### 拉取工作流草稿到本地（修改流程第一步）

```bash
# 拉取草稿到本地文件
curl -s -X POST "$USER_META_BASE_URL/web/workflow-defs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"get","workflowId":"<ID>"}' | jq -r '.data.draftYaml' > ./workflow/<ID>.yaml

# 查看内容
cat ./workflow/<ID>.yaml
```

`draftYaml` 是当前草稿内容字符串，`null` 表示草稿为空。

### 校验 YAML（dryRun — 保存前必须执行）

```bash
# 用本地 YAML 文件做干运行校验
jq -n --arg yaml "$(cat ./workflow/<ID>.yaml)" \
  '{action:"dryRun", yaml:$yaml}' | \
curl -s -X POST "$USER_META_BASE_URL/web/workflow-engine" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- | jq '.data | { valid, issues }'
```

返回 `{ valid: true, issues: [] }` 才可保存。如果 `valid: false`，检查 `issues` 数组修正错误。

### 保存草稿 YAML

```bash
# 从本地文件读取 YAML，提交到服务端
jq -n --arg yaml "$(cat ./workflow/<ID>.yaml)" --arg wfId "<WORKFLOW_ID>" \
  '{action:"save", workflowId:$wfId, yaml:$yaml}' | \
curl -s -X POST "$USER_META_BASE_URL/web/workflow-defs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- | jq '{ success }'
```

**注意**：必须用临时文件 + jq 传递 YAML，不要手动拼 JSON。

### 完整的创建+编辑+校验+保存示例

```bash
WF_ID="<WORKFLOW_ID>"
WF_FILE="./workflow/${WF_ID}.yaml"

# 1. 写 YAML 到本地
cat > "$WF_FILE" << 'EOF'
schema_version: "1"
name: my-workflow
description: "示例工作流"
params:
  env:
    type: string
    default: staging
nodes:
  - id: checkout
    type: shell
    description: "拉取代码"
    command: |
      echo "Checking out code..."
      printf "%s" "$PWD/repo"
  - id: build
    type: shell
    description: "构建项目"
    depends_on: [checkout]
    timeout: 120
    command: echo "Building project..."
  - id: notify
    type: shell
    description: "通知"
    depends_on: [build]
    inputs:
      DEPLOY_ENV: params.env
    command: echo "Deploy to $DEPLOY_ENV done"
EOF

# 2. dryRun 校验
jq -n --arg yaml "$(cat "$WF_FILE")" \
  '{action:"dryRun", yaml:$yaml}' | \
curl -s -X POST "$USER_META_BASE_URL/web/workflow-engine" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- | jq '.data | { valid, issues }'

# 3. 校验通过后保存
jq -n --arg yaml "$(cat "$WF_FILE")" --arg wfId "$WF_ID" \
  '{action:"save", workflowId:$wfId, yaml:$yaml}' | \
curl -s -X POST "$USER_META_BASE_URL/web/workflow-defs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- | jq '{ success }'
```

### 发布版本

```bash
curl -s -X POST "$USER_META_BASE_URL/web/workflow-defs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"publish","workflowId":"<ID>"}' | \
  jq '.data | { version }'
```

发布后得到的 `version` 是外部执行 API 的稳定版本号。生产集成建议在 execute 请求中显式传 `version`，而不是依赖随发布变化的 `latestVersion`。

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

## 二、外部执行 API — `/api/workflows/:workflowId/execute`

外部系统调用已发布工作流使用 REST 端点，不使用 `/web/*` 的 `{ success, data }` envelope，也不使用 `action` 字段。

### 同步执行并获取 end 节点输出

```bash
curl -s -X POST "$USER_META_BASE_URL/api/workflows/<WORKFLOW_ID>/execute" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "sync",
    "version": 3,
    "inputs": {
      "deploy_env": "staging"
    }
  }' | jq '{ runId, status, version, output, duration }'
```

响应示例：

```json
{
  "runId": "run_xxx",
  "status": "SUCCESS",
  "version": 3,
  "output": {
    "data": "build-artifact-v1.0.0.tar.gz"
  },
  "duration": 0.054
}
```

### 异步执行

```bash
curl -s -X POST "$USER_META_BASE_URL/api/workflows/<WORKFLOW_ID>/execute" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "async",
    "version": 3,
    "inputs": {
      "deploy_env": "staging"
    }
  }' | jq '{ runId, version }'
```

### execute 请求/响应规则

| 字段 | 类型 | 说明 |
|------|------|------|
| `mode` | `sync` \| `async` | 可选，默认 `sync`。`sync` 等待完成或超时，`async` 立即返回 `runId` |
| `version` | number | 可选。不传时执行当前 `latestVersion`；生产集成建议显式传发布版本号 |
| `inputs` | object | 可选，对应 YAML 顶层 `params` 的实际值 |
| `timeout` | number | 可选，sync 最大等待秒数，默认 300，超时返回 `TIMEOUT` 但工作流继续后台运行 |

成功调用返回裸对象：
- `sync + SUCCESS`：`{ runId, status, version, output?, duration }`
- `sync + FAILED`：`{ runId, status, version, error, duration }`
- `sync + TIMEOUT`：`{ runId, status, version, duration }`
- `async`：`{ runId, version }`

接口级错误才返回 `{ "error": { "code", "message" } }`。工作流执行失败属于业务结果，HTTP 仍可为 200，需检查响应体中的 `status`。

### End 节点：外部 API 的最终输出

`type: end` 节点用于定义外部 execute API 的最终 `output`。一个工作流最多一个 end 节点；如果没有 end 节点，同步成功响应不返回 `output` 字段。

```yaml
nodes:
  - id: build
    type: shell
    command: |
      printf "%s" "build-artifact-v1.0.0.tar.gz"

  - id: done
    type: end
    depends_on: [build]
    inputs:
      data: nodes.build.output.stdout
```

执行成功后：

```json
{
  "status": "SUCCESS",
  "output": {
    "data": "build-artifact-v1.0.0.tar.gz"
  }
}
```

**注意**：end 节点的 `inputs:` 使用裸表达式（如 `nodes.build.output.stdout`），与 Shell/Python 节点 inputs 一样需要手动声明 `depends_on`，确保上游节点先执行。

---

## 三、工作流执行引擎 — `/web/workflow-engine`

### 干运行（直接传入 YAML 校验）

```bash
# 方式一：传入本地 YAML 文件内容
jq -n --arg yaml "$(cat ./workflow/<ID>.yaml)" \
  '{action:"dryRun", yaml:$yaml}' | \
curl -s -X POST "$USER_META_BASE_URL/web/workflow-engine" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- | jq '.data | { valid, issues }'

# 方式二：指定已保存的工作流（使用草稿 YAML）
curl -s -X POST "$USER_META_BASE_URL/web/workflow-engine" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"dryRun","workflowId":"<ID>"}' | \
  jq '.data | { valid, issues }'
```

### 运行工作流

> ⚠️ **版本陷阱**：`run` 通过 `workflowId` 执行时，默认使用 **最新已发布版本**（`latestVersion`），而非草稿（`draft.yaml`）。这意味着：若工作流曾发布过版本，修改草稿后直接 `run`（不传 `version`）**跑的仍是旧版本**，导致运行结果与 YAML 不一致。

```bash
# 默认执行最新已发布版本（latestVersion），非草稿
curl -s -X POST "$USER_META_BASE_URL/web/workflow-engine" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"run","workflowId":"<ID>"}' | \
  jq '.data | { runId, status }'

# 显式传 version: 0 执行草稿
curl -s -X POST "$USER_META_BASE_URL/web/workflow-engine" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"run","workflowId":"<ID>","version":0}' | \
  jq '.data | { runId, status }'

# 直接传 yaml 参数直跑（绕过版本解析，适合开发调试）
jq -n --arg yaml "$(cat ./workflow/<ID>.yaml)" \
  '{action:"run", yaml:$yaml}' | \
curl -s -X POST "$USER_META_BASE_URL/web/workflow-engine" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- | jq '.data | { runId, status }'
```

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

---

## 六、YAML Schema 完整参考

### 顶层结构

```yaml
schema_version: "1"          # 必填，当前仅支持 "1"
name: "workflow-name"         # 必填，工作流名称
description: "可选描述"       # 可选
params:                       # 可选，参数定义
  param_name:
    type: string | number | boolean | object
    default: "默认值"
    required: true
secrets:                      # 可选，需要注入的密钥名列表
  - SECRET_NAME
timeout: 300                  # 可选，全局超时（秒）
nodes: [...]                  # 必填，节点列表
```

### 节点通用字段

所有节点类型共享：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | **是** | 节点唯一标识 |
| `type` | string | **是** | 节点类型 |
| `description` | string | 否 | 节点描述 |
| `depends_on` | string[] | 否 | 依赖的节点 ID 列表。使用 `${{ }}` 模板时自动推断，`inputs:` 块的裸表达式需手动声明 |
| `condition` | string | 否 | 条件表达式，满足时才执行 |
| `timeout` | number | 否 | 节点超时（秒） |
| `retry` | number 或 object | 否 | 重试次数或 `{ count, delay?, backoff? }` |
| `env` | Record<string, string> | 否 | 额外环境变量 |

### 模板表达式

| 表达式 | 说明 |
|--------|------|
| `nodes.<node_id>.output.stdout` | 引用上游节点 stdout 输出 |
| `nodes.<node_id>.output.<field>` | 引用上游节点 JSON 输出的子字段 |
| `nodes.<node_id>.output` | 引用上游节点的完整 output 对象 |
| `nodes.<node_id>.status` | 引用上游节点的运行状态 |
| `params.<param_name>` | 引用工作流参数 |
| `secrets.<secret_name>` | 引用密钥环境变量 |

> **重要**：表达式只允许 `nodes`、`params`、`secrets` 三个根命名空间，不支持其他变量名。在 shell/python 节点的 `inputs:` 块中使用这些表达式，引擎自动解析后注入为环境变量（shell）或 Python 变量。

**自动依赖推断**：仅在 Agent/API/Workflow 节点的 `prompt`/`url`/`body`/`headers` 等字段中使用 `${{ nodes.xxx }}` 模板时有效，引擎自动将 `xxx` 加入 `depends_on`。Shell/Python 节点的 `inputs:` 块使用裸表达式（不含 `${{ }}`），**必须手动声明 `depends_on`**。

> **默认输出**：所有节点类型（shell/python/agent/api/workflow/loop/transform）拖出时都会默认预填 `stdout` 输出声明，作为该节点的默认下游引用字段。除 LLM 节点外，其他节点可通过 `outputs:` 块声明额外输出字段。

### Shell 节点

执行 shell 命令。**Shell 节点不支持 `${{ }}` 模板解析**——节点间数据传递通过 `inputs:` 块完成：`inputs:` 中声明的表达式结果自动注入为 **环境变量**，命令中直接用 `$VAR_NAME` 引用（**禁止在 command 中使用 `${{ }}`，引擎不解析**）。

命令的 stdout 被完整捕获为节点输出。如果 stdout 是合法 JSON，引擎自动解析并可通过 `nodes.<id>.output.<json_field>` 访问子字段。

```yaml
nodes:
  - id: checkout
    type: shell
    description: "拉取代码"
    command: |
      echo "Checking out code..."
      printf "%s" "$PWD/repo"
    cwd: "./workspace"         # 可选，工作目录
    timeout: 120
    inputs:                    # 可选，注入为环境变量
      REPO_DIR: nodes.checkout.output.stdout
      ENV_NAME: params.deploy_env
    env:                       # 可选，额外静态环境变量
      DEBUG: "1"
```

> **YAML 最佳实践**：Shell 命令包含 `$`、`:`、`\n` 等易冲突字符时，统一用 `|` block scalar 写法，避免 YAML 解析器将 `:` 误判为 compact mapping 或 `\n` 被误解。

> **输出规范**：Shell 节点的 stdout 尾换行会被保留。如果希望下游获取"干净"值（无尾换行），使用 `printf` 代替 `echo`。

### Python 节点

执行 Python 代码。与 Shell 节点一样，**Python 节点不支持 `${{ }}` 模板解析**——`inputs:` 中声明的表达式结果自动注入为**环境变量**，Python 代码中通过 `os.environ["VAR"]` 获取（**禁止在 code 中使用 `${{ }}`，引擎不解析**）。

```yaml
nodes:
  - id: process
    type: python
    description: "数据处理"
    code: |
      import json, os
      input_data = os.environ.get("input_data", "")
      data = json.loads(input_data)
      result = {"count": len(data)}
      print(json.dumps(result))
    requirements:              # 可选
      - requests
      - numpy
    cwd: "./workspace"
    inputs:                    # 可选，注入为环境变量
      input_data: nodes.fetch.output.stdout
```

### Agent 节点

向在线 Environment 的 Agent 发送 prompt 执行任务。**Agent 节点支持 `${{ }}` 模板解析**，`prompt` 和 `agent` 字段中的表达式在运行时会自动求值。

**Agent 节点输出**：`stdout` 为简化结果文本，`output.simplified` 为 Agent 会话流简化内容（`${{ }}` 模板解析时自动取此字段）。下游可通过 `nodes.<id>.output.stdout` 或 `nodes.<id>.output.messages` 引用。

```yaml
nodes:
  - id: review
    type: agent
    description: "AI 代码审查"
    depends_on: [checkout]
    agent: "my-environment"    # 必填，Environment 名称
    prompt: |
      请审查以下代码变更：
      ${{ nodes.checkout.output.stdout }}
    output_messages: 3         # 可选，回传最后 N 条原始消息给下游
```

### API 节点

发起 HTTP 请求。**API 节点支持 `${{ }}` 模板解析**，`url`、`body`、`headers` 中的表达式在运行时会自动求值。

```yaml
nodes:
  - id: notify
    type: api
    description: "发送通知"
    depends_on: [build]
    url: "https://hooks.example.com/notify"
    method: "POST"             # 可选，默认 GET
    headers:                   # 可选
      Content-Type: "application/json"
      Authorization: "Bearer ${{ secrets.API_TOKEN }}"
    body: |                    # 可选
      {"status": "${{ nodes.build.output.stdout }}"}
```

### Audit 节点（人工审批）

暂停执行等待人工审批。

```yaml
nodes:
  - id: approve-deploy
    type: audit
    description: "部署审批"
    depends_on: [test]
    display_data:              # 可选，展示给审批人的任意数据
      title: "部署到生产环境"
      environment: "production"
    expires_in: 3600           # 可选，审批超时（秒）
```

### Workflow 节点（子工作流）

嵌套调用另一个工作流。**Workflow 节点支持 `${{ }}` 模板解析**，`ref` 和 `params` 中的表达式在运行时会自动求值。

```yaml
nodes:
  - id: run-build
    type: workflow
    description: "调用构建工作流"
    ref: "${{ params.build_workflow_name }}"  # 必填，目标工作流名称（支持表达式）
    params:                    # 可选，传给子工作流的参数
      repo_url: "${{ nodes.checkout.output.stdout }}"
      branch: "main"
    ignore_errors: false       # 可选，忽略子工作流错误
```

### Loop 节点（循环）

循环执行子节点组。

```yaml
nodes:
  - id: batch-process
    type: loop
    description: "批量处理"
    condition: "${{ params.items.length > 0 }}"  # 必填，循环条件
    max_iterations: 100                         # 必填，最大迭代次数
    body:
      nodes:
        - id: process-item
          type: shell
          command: echo "Processing item..."
```

### Custom 节点：Slurm（HPC 作业调度）

`type: custom, tool: slurm`。通过 SSH + sbatch + sacct 向远程 HPC 集群提交作业。项目内置 `tools/slurm.ts`。

| 字段 | 必填 | 说明 |
|------|------|------|
| `slurm.partition` | **是** | 队列名（如 `xahcnormal`） |
| `slurm.cores` | 否 | CPU 核数，默认 1 |
| `slurm.memory` | 否 | 内存限制，如 `"100G"` |
| `slurm.walltime` | 否 | 时间限制，如 `"04:00:00"` |
| `slurm.modules` | 否 | module load 列表，如 `["apps/apptainer/1.2.4"]` |
| `slurm.extraSBATCH` | 否 | 额外 `#SBATCH` 指令，如 `["--gres=gpu:1"]` |
| `script.content` | **是** | bash 脚本正文，支持 `${{ }}` 模板。**不要写 `#!/bin/bash` 或 `#SBATCH`（引擎自动生成）** |
| `script.env` | 否 | 注入到 `#SBATCH --export` 的环境变量 |

> `$SLURM_CPUS_PER_TASK` 自动可用，引擎保留 Slurm 标准环境变量。集群连接通过 `params.cluster_host`（SSH config 别名），需 `~/.ssh/config` 免密登录。默认不重试，`OUT_OF_MEMORY` / `CANCELLED` 固定不重试。

**Slurm 节点常见坑（YAML 编写前必读）**：

> ⚠️ **1. `params.work_dir` 必须是集群上可写的绝对路径**。写错用户名（如 `/work/home/agent/...` vs `/work/home/liwei_agent/...`）会导致 `mkdir` / `sbatch` 权限拒绝。先用 `ssh <host> "ls -d <path>"` 确认路径存在且有写权限。

> ⚠️ **2. 不要在上游 shell 节点中依赖本地文件系统**。Slurm 作业跑在远程集群，引擎本地的 `/tmp/xxx` 或 `./output.txt` 在集群上不可访问。数据传递应通过 `inputs` 环境变量注入或 `params` 模板求值。

> ⚠️ **3. `script.env` 的值必须用 `${{ }}` 包裹才能求值**。`inputs` 走 `resolveInputs` 自动求值，裸写 `nodes.X.output.Y` 即可。但 `script.env` 走 `resolveTemplate`，**不写 `${{ }}` 的表达式会被当作字面量字符串**，直接注入为 `#SBATCH --export=KEY=nodes.X.output.stdout`（原始字符串，不会被替换）。

> ⚠️ **4. inputs/env 的值避免逗号、换行符**。这些值会被拼入 `#SBATCH --export=ALL,KEY1=v1,KEY2=v2`，逗号打断字段边界，换行符直接破坏行结构。上游 shell 节点也应用单行输出（`echo "value"` 而非多行 `echo`），避免 stdout 含换行污染下游。

```yaml
nodes:
  - id: trim_galore
    type: custom
    tool: slurm
    slurm:
      partition: xahcnormal
      cores: 4
      walltime: "02:00:00"
      modules: ["apps/apptainer/1.2.4"]
    script:
      content: |
        mkdir -p ${{ params.work_dir }}/step_4
        apptainer exec --bind ${{ params.apptainer_bind }} ${{ params.sif }} \
          trim_galore --paired --cores "$SLURM_CPUS_PER_TASK" \
            --output_dir ${{ params.work_dir }}/step_4 --gzip \
            ${{ params.sample_r1 }} ${{ params.sample_r2 }}
        test -s "${{ params.work_dir }}/step_4/${{ params.sample_id }}_1_val_1.fq.gz" || exit 1
    outputs:
      trimmed_r1:
        pattern: "${{ params.work_dir }}/step_4/${{ params.sample_id }}_1_val_1.fq.gz"
        type: file

### Custom 节点：LLM（大模型推理）

`type: custom, tool: llm`。调用 OpenAI 兼容 API 进行大模型推理，项目内置 `tools/llm.ts`。

**Inputs 参数**（在 YAML `inputs:` 块中声明）：

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `user_prompt` | **是** | — | 用户提示词，支持 `${{ }}` 表达式 |
| `system_prompt` | 否 | — | 系统提示词 |
| `model` | 否 | `gpt-4o` | 模型名称 |
| `temperature` | 否 | `0.7` | 采样温度 (0-2) |
| `max_tokens` | 否 | 模型默认 | 最大输出 token 数 |
| `response_format` | 否 | `"text"` | `"text"` 或 `"json_object"` |
| `api_key` | 否 | — | API Key，建议走 `secrets:` |
| `base_url` | 否 | `https://api.openai.com/v1` | API 基础地址 |
| `output_contains` | 否 | — | 输出必须包含此文本，否则节点 **FAILED** |

**Produces 输出**：`stdout`（文本）、`json`（JSON 解析结果）、`exit_code`、`size`。

> **自动预填**：LLM 节点的 outputs（`stdout`、`json`、`exit_code`、`size`）在拖出节点时会自动预填，类型为 `type: value`（计算值）。YAML 中写为 `stdout: { pattern: "", type: value }`，`json: { pattern: "", type: value }` 等。

> **删除/改名确认**：当 LLM 节点的输出字段（如 `stdout`、`json`、`exit_code`、`size`）已被下游节点引用时，在前端编辑器中删除或改名该字段会弹出确认对话框。**改名**会同步更新所有下游引用路径，**删除**会清除引用（下游节点对应表达式将被清空）。其他节点类型的手动输出字段同样适用此规则。

**API Key 优先级**：`inputs.api_key` > `secrets.OPENAI_API_KEY` > 环境变量 `OPENAI_API_KEY`。

```yaml
nodes:
  - id: classify_sample
    type: custom
    tool: llm
    inputs:
      user_prompt: "分类样本：${{ nodes.featurecounts.output.stdout }}"
      system_prompt: "你是生物信息学专家，只输出 JSON"
      model: "gpt-4o-mini"
      temperature: "0.3"
      response_format: json_object

  - id: check_result
    type: custom
    tool: llm
    depends_on: [classify_sample]
    inputs:
      user_prompt: "${{ nodes.classify_sample.output.stdout }}"
      output_contains: "type"
```

**对比**：Slurm（SSH + sbatch，适合 HPC 计算）vs LLM（HTTP fetch，适合 AI 推理）。

---

## 七、完整 YAML 样例

### 样例 1：基础 Shell 串行流水线

```yaml
schema_version: "1"
name: simple-pipeline
description: "最基础的串行流水线：checkout → build → test → deploy"
params:
  deploy_env:
    type: string
    default: staging
nodes:
  - id: checkout
    type: shell
    description: "拉取代码"
    command: |
      echo "Checking out code..."
      printf "%s" "$PWD/repo"

  - id: build
    type: shell
    description: "构建项目"
    depends_on: [checkout]
    timeout: 120
    inputs:
      REPO_DIR: nodes.checkout.output.stdout
    command: |
      echo "Building in $REPO_DIR..."
      printf "%s" "./dist/app.tar.gz"

  - id: test
    type: shell
    description: "运行测试"
    depends_on: [build]
    command: echo "Running tests..."

  - id: deploy
    type: shell
    description: "部署到目标环境"
    depends_on: [test]
    inputs:
      ENV: params.deploy_env
    command: |
      echo "Deploying to $ENV..."
```

### 样例 2：并行 + 条件 + 错误处理

```yaml
schema_version: "1"
name: advanced-pipeline
description: "展示并行执行、条件分支、重试、超时、错误容忍"
params:
  deploy_env:
    type: string
    default: staging
nodes:
  - id: checkout
    type: shell
    description: "拉取代码（自动重试）"
    retry: 2
    command: |
      echo "Checking out code..."
      printf "%s" "$PWD/repo"

  # checkout 之后 build 和 lint 并行执行
  - id: build
    type: shell
    description: "构建"
    depends_on: [checkout]
    timeout: 300
    command: |
      echo "Building..."
      printf "%s" "./dist/app.tar.gz"

  - id: lint
    type: shell
    description: "代码检查"
    depends_on: [checkout]
    command: echo "Linting..."

  - id: test
    type: shell
    description: "测试（容忍失败）"
    depends_on: [build]
    retry:
      count: 1
      delay: 5
      backoff: exponential
    command: echo "Running tests..."

  # 仅生产环境部署（condition 基于 params）
  - id: deploy-prod
    type: shell
    description: "生产部署"
    condition: "${{ params.deploy_env == 'production' }}"
    depends_on: [test, lint]
    command: echo "Deploying to production..."

  # 人工审批
  - id: approve
    type: audit
    description: "部署审批"
    depends_on: [deploy-prod]
    display_data:
      title: "确认部署到生产环境"
      env: "${{ params.deploy_env }}"
    expires_in: 3600

  # 无论部署成功与否都通知
  - id: notify
    type: shell
    description: "发送通知"
    depends_on: [test, lint]
    inputs:
      ENV: params.deploy_env
    command: echo "Pipeline completed for $ENV"
```

### 样例 3：Agent 协作 + API 通知

```yaml
schema_version: "1"
name: agent-review-flow
description: "代码变更 → Agent 审查 → API 通知"
params:
  repo_url:
    type: string
    required: true
  notify_webhook:
    type: string
    required: true
secrets:
  - GITHUB_TOKEN
nodes:
  - id: fetch-diff
    type: shell
    description: "获取代码变更"
    inputs:
      REPO_URL: params.repo_url
    command: |
      curl -s -H "Authorization: token $GITHUB_TOKEN" \
        "$REPO_URL/pulls/1" | jq -r '.diff' > /tmp/diff.txt
      printf "%s" "/tmp/diff.txt"

  - id: ai-review
    type: agent
    description: "AI 代码审查"
    depends_on: [fetch-diff]
    agent: "code-reviewer"
    prompt: |
      请审查以下代码变更，输出审查意见：
      $(cat ${{ nodes.fetch-diff.output.stdout }})
    output_messages: 5

  - id: notify
    type: api
    description: "发送审查结果通知"
    depends_on: [ai-review]
    url: "${{ params.notify_webhook }}"
    method: "POST"
    headers:
      Content-Type: "application/json"
    body: |
      {"review_result": "completed"}
```

### 样例 4：子工作流 + 循环

```yaml
schema_version: "1"
name: multi-service-deploy
description: "多服务批量部署：调用子工作流 × 循环"
params:
  services:
    type: string
    default: "api,web,worker"
nodes:
  - id: build-all
    type: workflow
    description: "调用通用构建工作流"
    ref: "build-lib"
    params:
      repo_url: "https://github.com/org/mono-repo"
      branch: "main"

  - id: smoke-test
    type: loop
    description: "循环健康检查"
    depends_on: [build-all]
    condition: "true"
    max_iterations: 5
    body:
      nodes:
        - id: health-check
          type: shell
          command: |
            STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/health)
            if [ "$STATUS" = "200" ]; then
              printf "healthy"
            else
              sleep 2
            fi

  - id: final-notify
    type: shell
    description: "最终通知"
    depends_on: [smoke-test]
    command: echo "All services deployed successfully"
```

### 样例 5：Slurm + LLM 混合

Slurm 节点语法见 [六 → Custom 节点：Slurm](#custom-节点slurmhpc-作业调度)，LLM 节点语法见 [六 → Custom 节点：LLM](#custom-节点llm大模型推理)。完整示例参考 `workflow-examples/pe-rna-seq-single-sample.yaml`。

---

## 八、常见错误与排查

### dryRun 错误

| dryRun 错误代码 | 含义 | 解决方式 |
|------------------|------|----------|
| `INVALID_YAML` | YAML 语法错误或缺少必填字段 | 检查 `schema_version`、`name`、`nodes` 是否存在 |
| `DUPLICATE_NODE_ID` | 节点 ID 重复 | 确保每个节点 `id` 唯一 |
| `CYCLE_DETECTED` | DAG 存在循环依赖 | 检查 `depends_on` 链是否存在环路 |
| `MISSING_DEPENDENCY` | `depends_on` 引用了不存在的节点 | 确认引用的节点 ID 存在 |
| `UNDEFINED_VARIABLE` | 使用了不允许的变量名（如 `inputs.xxx`、`needs.xxx`） | 使用正确的根命名空间：`nodes.`、`params.`、`secrets.` |
| `MISSING_SCRIPT` | Slurm 节点缺少 `script.content` 字段 | 添加 `script.content` 声明 bash 脚本正文 |
| `INVALID_SCRIPT_ON_NON_SLURM` | 非 Slurm 节点误写了 `script` 字段 | 删除 `script` 字段，仅 Slurm 节点支持 |

### 运行时常见错误

| 错误现象 | 原因 | 解决方式 |
|----------|------|----------|
| shell 命令中出现 `${{ }}` 字面量 | Shell 节点 `command` 不做模板解析，`${{ }}` 被当作 shell 字面量 | 改用 `inputs:` 块注入，令中用 `$VAR` 引用 |
| 下游节点拿不到上游数据 | 引用路径错误（如用了旧格式 `needs.xxx.outputs.xxx`） | 改用 `nodes.<id>.output.<field>` |
| `printf` 和 `echo` 输出不一致 | `echo` 默认追加换行，`printf` 不追加 | 需要干净输出值时用 `printf` |
| `:` 在 YAML 行内 command 中触发 compact mapping 错误 | YAML 解析器把 `:` 当成键值分隔符 | command 统一用 `\|` block scalar |
| Slurm: sacct 空数据超时 | slurmdbd 延迟，5 分钟后仍查不到 | 检查集群 sacct 权限或增大 `timeout` |
| Slurm: OOM 反复重试 | `OUT_OF_MEMORY` 不重试，`maxRetries` 对它不生效 | 增大 `slurm.memory` |
| Slurm: mkdir/sbatch Permission denied | `params.work_dir` 路径不可写或用户名错误 | ssh 到集群确认路径存在且有写权限 |
| Slurm: sbatch Unable to open file | `uploadScript` 阶段 silent 失败，脚本未写入 | 检查 `params.work_dir` 路径权限 |
| Slurm: `script.env` 值未被求值 | 未用 `${{ }}` 包裹，被当作字面量字符串 | 写成 `KEY: "${{ nodes.X.output.Y }}"` |
| Slurm: `#SBATCH --export` 行断裂 | input/env 值含逗号或换行符 | 确保上游输出为单行干净值，避免逗号 |
| LLM: HTTP 4xx | API Key 无效 | 检查 `secrets.OPENAI_API_KEY` |
| LLM: output_contains 校验失败 | LLM 未返回预期关键词 | 放宽条件或优化 prompt |

**节点类型特定错误**：
- `shell` 节点必须有 `command`
- `python` 节点必须有 `code`
- `agent` 节点必须有 `prompt` 和 `agent`（环境名称）
- `api` 节点必须有 `url`
- `workflow` 节点必须有 `ref`
- `loop` 节点必须有 `condition`、`max_iterations` 和 `body.nodes`
- `custom` / `slurm` 节点必须有 `script.content`，且不能遗漏 `slurm.partition`
- `custom` / `llm` 节点必须有 `user_prompt`（在 `inputs:` 块中声明）

### YAML 编写最佳实践

1. **❗ Shell command 必须用 `|` block scalar**：**这是强制规则，不是建议。** Shell 命令中只要出现了 `:`、`$`、`\n`、`{}` 等字符，必须用 `|` 写法。**禁止**把 shell 命令写在行内（inline），因为 YAML 解析器会把 `:` 后的内容当 compact mapping 解析，导致校验失败或静默截断。

   ```yaml
   # ❌ 错误：inline 写法，: 被 YAML 误解析为 compact mapping
   command: printf "字符数: %s" "$(echo "$INPUT" | wc -c | tr -d ' ')"
   
   # ✅ 正确：block scalar 写法
   command: |
     printf "字符数: %s" "$(echo "$INPUT" | wc -c | tr -d ' ')"
   ```
2. **Shell 输出用 `printf` 代替 `echo`**：`printf` 不追加尾换行
3. **Shell/Python 节点不用 `${{ }}`**：通过 `inputs:` 注入，变量引用环境变量
4. **Agent/API/Workflow/Slurm 节点可用 `${{ }}`**：`prompt`、`url`、`script.content` 等字段支持
5. **表达式根命名空间仅三个**：`nodes.`、`params.`、`secrets.`
6. **dryRun 不等于完整验证**：只校验结构，不校验运行时语义
7. **Slurm `script.content` 不写 `#!/bin/bash` 或 `#SBATCH`**：引擎自动生成
8. **Slurm 集群 SSH 免密**：`params.cluster_host` 需在 `~/.ssh/config` 中配置
9. **LLM API Key 走 `secrets:`**：避免 YAML inputs 中硬编码
