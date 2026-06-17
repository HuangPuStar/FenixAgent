---
name: api-workflow
description: 工作流（Workflow）API。当需要"创建工作流"、"保存 YAML"、"发布版本"、"运行工作流"、"查看运行状态"、"管理触发器"、"看板管理"、"作业管理"时使用。使用 curl + jq 调用 REST API。
allowed-tools: Bash
---

# Workflow API

管理工作流定义、版本、执行引擎、看板和作业。所有工作流 API 使用 `POST` + JSON body `action` 字段。

---

## 〇、Agent 操作工作流的标准流程

Agent 操作工作流时，遵循 **拉取 → 编辑本地 → 校验 → 保存** 的循环：

### 新建工作流流程

```
1. 创建空工作流定义 → 获得 workflowId
2. 将 YAML 写入本地临时文件 /tmp/workflow-<workflowId>.yaml
3. 用 dryRun 接口校验 YAML 合法性
4. 校验通过后 save 草稿
5. 发布版本（可选）
```

### 修改已有工作流流程

```
1. 用 get 接口拉取最新草稿 YAML 到本地 /tmp/workflow-<workflowId>.yaml
2. 在本地编辑 YAML
3. 用 dryRun 校验
4. 校验通过后 save 回服务端
5. 发布新版本（可选）
```

**核心原则**：
- **每次操作前先拉取最新数据**到本地，避免覆盖他人修改
- **必须先通过 dryRun 校验再保存**，确保 YAML 语法和 DAG 结构正确
- 使用本地文件 `/tmp/workflow-<workflowId>.yaml` 作为 Agent 的"工作副本"
- 用 `jq -n --arg yaml "$(cat /tmp/xxx.yaml)"` 传递 YAML 内容，不要手动拼 JSON

> ⚠️ **dryRun 局限性**：dryRun 只校验 YAML 语法合法性、节点 ID 唯一性、DAG 环检测、依赖引用存在性。**不校验运行时语义**——例如 `nodes.xxx.output.stdout` 引用的上游节点在运行时是否真正有对应字段、`params.xxx` 是否因拼写错误指向不存在的参数。因此 dryRun 通过不代表工作流一定能成功运行。涉及数据传递的 YAML 建议从 `inputs-e2e.test.ts` 等 E2E 测试中确认引用路径格式。

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
  -d '{"action":"get","workflowId":"<ID>"}' | jq -r '.data.draftYaml' > /tmp/workflow-<ID>.yaml

# 查看内容
cat /tmp/workflow-<ID>.yaml
```

`draftYaml` 是当前草稿内容字符串，`null` 表示草稿为空。

### 校验 YAML（dryRun — 保存前必须执行）

```bash
# 用本地 YAML 文件做干运行校验
jq -n --arg yaml "$(cat /tmp/workflow-<ID>.yaml)" \
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
jq -n --arg yaml "$(cat /tmp/workflow-<ID>.yaml)" --arg wfId "<WORKFLOW_ID>" \
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
WF_FILE="/tmp/workflow-${WF_ID}.yaml"

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

### 干运行（直接传入 YAML 校验）

```bash
# 方式一：传入本地 YAML 文件内容
jq -n --arg yaml "$(cat /tmp/workflow-<ID>.yaml)" \
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

### Shell 节点

执行 shell 命令。**Shell 节点不支持 `${{ }}` 模板解析**——节点间数据传递通过 `inputs:` 块完成：表达式结果注入为 shell 环境变量，命令中直接用 `$VAR_NAME` 引用。

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

执行 Python 代码。与 Shell 节点一样，**Python 节点不支持 `${{ }}` 模板解析**——数据通过 `inputs:` 块注入为 Python 变量。

```yaml
nodes:
  - id: process
    type: python
    description: "数据处理"
    code: |
      import json
      data = json.loads(input_data)
      result = {"count": len(data)}
      print(json.dumps(result))
    requirements:              # 可选
      - requests
      - numpy
    cwd: "./workspace"
    inputs:                    # 可选，注入为 Python 变量
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

### 运行时常见错误

| 错误现象 | 原因 | 解决方式 |
|----------|------|----------|
| shell 命令中出现 `${{ }}` 字面量 | Shell 节点 `command` 不做模板解析，`${{ }}` 被当作 shell 字面量 | 改用 `inputs:` 块注入，令中用 `$VAR` 引用 |
| 下游节点拿不到上游数据 | 引用路径错误（如用了旧格式 `needs.xxx.outputs.xxx`） | 改用 `nodes.<id>.output.<field>` |
| `printf` 和 `echo` 输出不一致 | `echo` 默认追加换行，`printf` 不追加 | 需要干净输出值时用 `printf` |
| `:` 在 YAML 行内 command 中触发 compact mapping 错误 | YAML 解析器把 `:` 当成键值分隔符 | command 统一用 `\|` block scalar |

**节点类型特定错误**：
- `shell` 节点必须有 `command`
- `python` 节点必须有 `code`
- `agent` 节点必须有 `prompt` 和 `agent`（环境名称）
- `api` 节点必须有 `url`
- `workflow` 节点必须有 `ref`
- `loop` 节点必须有 `condition`、`max_iterations` 和 `body.nodes`

### YAML 编写最佳实践

1. **Shell command 统一用 `|` block scalar**：字符串含 `:`、`$`、`\n` 等易冲突字符时避免行内写法
2. **Shell 输出用 `printf` 代替 `echo`**：`printf` 不追加尾换行，输出值更干净
3. **Shell/Python 节点不用 `${{ }}` 做数据传递**：统一通过 `inputs:` 块注入，命令中引用环境变量
4. **Agent/API/Workflow 节点可用 `${{ }}`**：`prompt`、`url`、`body` 等字段支持模板解析
5. **表达式根命名空间仅三个**：`nodes.`、`params.`、`secrets.`，不用 `inputs.` 或 `needs.`
6. **dryRun 不等于完整验证**：只校验结构，不校验运行时语义
