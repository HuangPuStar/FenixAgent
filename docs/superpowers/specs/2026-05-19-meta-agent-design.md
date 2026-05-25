# Feature: Meta Agent — 工作流编辑器右侧 Chat 智能助手

## 需求背景

用户在工作流编辑器中编排 DAG 节点时，需要手动拖拽、配置参数、修改 YAML。希望通过一个 Meta Agent（全局智能助手），让用户用自然语言描述需求，Agent 通过读写工作流 YAML 文件自动完成编排。

## 目标

- 在工作流编辑器右侧新增可折叠 Chat 侧边栏
- Meta Agent 复用现有 Agent + ACP relay 体系，不单独开发
- Agent 通过一个专属 Skill 学习如何操作工作流 YAML 文件
- 每个 user/team 权限隔离，Agent 只访问自己 workspace 下的文件
- Agent 只编排/修改 YAML，不执行工作流（执行留给用户）

## 架构设计

### 调用链路

```
用户在 Chat 中输入："帮我加一个数据清洗节点"
    ↓ ACP Relay WebSocket
Meta Agent（opencode 实例，带专属 skill）
    ↓ Agent 读取 skill，学习如何操作
Agent 读写文件系统上的 draft.yaml
    ↓ 文件变更
工作流编辑器刷新画布
    ↓ 用户在编辑器点击"运行"
用户自行决定执行
```

### Meta Agent 身份

Meta Agent 本质上是一个普通的 Agent，通过内置约定来识别：

| 属性 | 值 |
|------|------|
| AgentConfig name | `meta`（内置，与 build/plan/general 同级） |
| Environment name | `__meta__`（按 user/team 查找或创建） |
| 专属 Skill | 1 个，教 Agent 如何读写工作流 YAML 文件 |
| 实例类型 | 按需 spawn（复用 `spawnInstanceFromEnvironment`） |
| 连接方式 | ACP relay WebSocket（复用现有 `ChatPanel` 组件） |

### 前端布局

```
┌──────────┬─────────────────────────┬─────────────────────┐
│ 节点面板  │   ReactFlow 画布         │   Chat 侧边栏        │
│ ~180px   │   flex-1（自动缩窄）      │   ~320px 可折叠      │
│          │                         │   复用 ChatPanel     │
└──────────┴─────────────────────────┴─────────────────────┘
```

Chat 面板展开时，ReactFlow 画布宽度自动缩小（flex 布局），不做 overlay 覆盖。

### 权限隔离

- 每个 user/team 自动创建独立的 meta Environment（name=`__meta__`）
- Skill 的 `agentConfigId` 关联到 `meta` AgentConfig
- ACP relay 连接带 session cookie，走现有 AuthContext
- Agent 只能访问自己 workspace 下的文件
- 工作流 YAML 按 `teamId + workflowId` 隔离存储

### 工作流文件路径

```
{workspace}/.agents/workflows/{teamId}/{workflowId}/draft.yaml
```

`__meta__` environment 的 `workspacePath` 设为用户的主工作空间根目录。前端打开 Chat 时，通过 ACP relay 的 session 初始消息（或 `initialCwd` 参数）将当前工作流的完整文件路径告知 Agent。Agent 的 Skill 教它如何定位和操作这个文件。

### 前端变更检测

Agent 修改 draft.yaml 后，前端需要感知变更并刷新画布。方案：**监听 Agent 回复 + 主动拉取**。

1. Agent 在 Chat 中回复时（如"已添加节点"），前端收到 ACP relay 消息
2. 前端在收到 assistant 消息后，调用 `workflowDefApi.get(workflowId)` 拉取最新 draftYaml
3. 用 `yamlToFlow()` 解析后更新 ReactFlow 的 nodes 和 edges 状态
4. 如果 YAML 未变（Agent 回复了但没改文件），画布不动

## 工作流 YAML 格式规范

### 根结构

```yaml
schema_version: "1"          # 必填，目前仅支持 "1"
name: "my-workflow"          # 必填，工作流名称
description: "..."           # 可选，描述
timeout: 300                 # 可选，全局超时（秒），默认 300
params:                      # 可选，参数定义
  input_path:
    type: string
    required: true
  batch_size:
    type: number
    default: 100
secrets:                     # 可选，需要注入的密钥名列表
  - DB_PASSWORD
  - API_TOKEN
nodes:                       # 必填，节点数组（顺序不决定执行顺序）
  - id: "shell_1"
    type: "shell"
    # ...
```

### 节点通用字段

每个节点都包含以下基础字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 节点唯一标识，格式建议 `{type}_{n}`（如 `shell_1`） |
| `type` | string | 是 | 节点类型：shell / python / agent / api / audit / workflow / loop |
| `depends_on` | string[] | 否 | 依赖的节点 ID 列表。空数组或省略 = 根节点（连到 __start__） |
| `condition` | string | 否 | 执行条件表达式（如 `"${{ params.dry_run }}" == false"`） |
| `timeout` | number | 否 | 节点级超时（秒），覆盖全局 timeout |
| `env` | map | 否 | 环境变量，支持 `${{ params.xxx }}` 和 `${{ secrets.xxx }}` 模板 |
| `retry` | object | 否 | 重试配置：`{ count: 2, delay: 1000, backoff: "fixed" \| "exponential" }` |

### Shell 节点

```yaml
- id: "shell_1"
  type: "shell"
  depends_on: []
  command: "echo 'hello world'"
  # 或多命令数组：
  # command: ["echo 'step 1'", "echo 'step 2'"]
  cwd: "/workspace"           # 可选，工作目录
```

### Python 节点

```yaml
- id: "python_1"
  type: "python"
  depends_on: ["shell_1"]
  code: |
    import json
    data = json.loads('${{ params.input }}')
    result = [x for x in data if x['valid']]
    print(json.dumps(result))
  requirements:               # 可选，pip 依赖
    - "requests>=2.28"
    - "pandas"
  cwd: "/workspace"           # 可选
```

Python 脚本的 stdout 作为节点输出。如果 stdout 是合法 JSON，自动解析为结构化数据供下游节点引用。

### Agent 节点

```yaml
- id: "agent_1"
  type: "agent"
  depends_on: ["python_1"]
  prompt: "分析以下数据并生成报告：${{ nodes.python_1.output }}"
  agent: "general"            # 可选，指定 Agent 名称，默认 "general"
  skill: "data-analysis"      # 可选，Agent 应调用的 skill
  model: "claude-sonnet-4-6"  # 可选，覆盖 Agent 配置中的模型
  temperature: 0.7            # 可选，覆盖温度
  steps: 10                   # 可选，覆盖最大步数
  retry:
    count: 2
    backoff: "exponential"
```

### API 节点

```yaml
- id: "api_1"
  type: "api"
  depends_on: ["agent_1"]
  url: "https://api.example.com/data"
  method: "POST"              # 可选，默认 GET
  headers:                    # 可选
    Authorization: "Bearer ${{ secrets.API_TOKEN }}"
    Content-Type: "application/json"
  body: '{"query": "${{ params.query }}"}'  # 可选
```

### Audit 节点（人工审批）

```yaml
- id: "audit_1"
  type: "audit"
  depends_on: ["api_1"]
  display_data:               # 可选，展示给审批人的数据
    summary: "请确认数据准确性"
    records: 42
  expires_in: 3600            # 可选，审批超时（秒）
```

### 子工作流节点

```yaml
- id: "sub_wf_1"
  type: "workflow"
  depends_on: ["shell_1"]
  ref: "shared/cleanup"       # 引用的工作流路径
  params:                     # 可选，传入子工作流的参数
    input_dir: "/data/raw"
  ignore_errors: true         # 可选，子工作流失败不阻断
```

### Loop 节点

```yaml
- id: "loop_1"
  type: "loop"
  depends_on: []
  condition: "${{ params.hasMore }}"
  max_iterations: 10
  body:
    nodes:
      - id: "loop_shell_1"
        type: "shell"
        command: "echo 'iteration'"
```

### 模板语法

节点中的字符串支持 `${{ expression }}` 模板：

| 变量 | 说明 | 示例 |
|------|------|------|
| `${{ params.xxx }}` | 工作流参数 | `${{ params.input_path }}` |
| `${{ secrets.xxx }}` | 密钥值 | `${{ secrets.DB_PASSWORD }}` |
| `${{ nodes.{id}.output }}` | 上游节点输出 | `${{ nodes.shell_1.stdout }}` |
| `${{ nodes.{id}.json.field }}` | 上游 JSON 输出字段 | `${{ nodes.python_1.json.count }}` |

### 完整示例

```yaml
schema_version: "1"
name: "data-pipeline"
description: "数据清洗 + 分析 + 通知流水线"
timeout: 600
params:
  input_path:
    type: string
    required: true
  batch_size:
    type: number
    default: 100
secrets:
  - DB_PASSWORD
  - SLACK_WEBHOOK

nodes:
  - id: "shell_fetch"
    type: "shell"
    command: "curl -s ${{ params.input_path }} -o /tmp/raw.json"

  - id: "python_clean"
    type: "python"
    depends_on: ["shell_fetch"]
    code: |
      import json
      with open("/tmp/raw.json") as f:
          data = json.load(f)
      cleaned = [r for r in data if r.get("valid")]
      with open("/tmp/cleaned.json", "w") as f:
          json.dump(cleaned, f)
      print(json.dumps({"count": len(cleaned)}))

  - id: "agent_analyze"
    type: "agent"
    depends_on: ["python_clean"]
    prompt: |
      分析清洗后的数据统计：
      总记录数: ${{ nodes.python_clean.json.count }}
      请生成一份简要报告。
    agent: "general"
    model: "claude-sonnet-4-6"
    steps: 5

  - id: "api_notify"
    type: "api"
    depends_on: ["agent_analyze"]
    url: "${{ secrets.SLACK_WEBHOOK }}"
    method: "POST"
    headers:
      Content-Type: "application/json"
    body: '{"text": "Pipeline completed"}'

  - id: "audit_review"
    type: "audit"
    depends_on: ["agent_analyze"]
    display_data:
      message: "请确认分析报告准确性"
    expires_in: 3600
```

## 新增改动清单

### 后端（最小改动）

1. **内置 AgentConfig `meta`**：在 seed 脚本或 migration 中创建，与 build/plan/general 同级
2. **内置 Skill**：Markdown 文件，教 Agent 如何定位和读写 `.agents/workflows/{teamId}/{workflowId}/draft.yaml`
3. **新 API `POST /web/meta-agent/ensure`**：查找或创建 meta environment（name=`__meta__`）+ spawn 实例，返回 environmentId
4. **工作流 draft.yaml 文件持久化**：确保编辑器保存时写入文件系统 `.agents/workflows/{teamId}/{workflowId}/draft.yaml`，同时保持数据库同步

### 前端

1. **WorkflowEditor 右侧可折叠 Chat 侧边栏**：复用 `ChatPanel` 组件（agent-panel 已有），传入 meta agent 的 environmentId
2. **工具栏 "Meta Agent" 切换按钮**：控制 Chat 面板显示/隐藏，状态持久化到 localStorage
3. **首次打开调用 ensure API**：后续直接连接已有实例
4. **文件变更检测**：监听 Agent 回复，收到 assistant 消息后主动拉取最新 draftYaml 刷新画布

## 验收标准

- [ ] 工作流编辑器工具栏有 "Meta Agent" 按钮
- [ ] 点击按钮后右侧展开 Chat 侧边栏，ReactFlow 画布自动缩窄
- [ ] 首次打开自动创建 meta environment 并 spawn 实例
- [ ] Chat 面板复用 ChatPanel 组件，通过 ACP relay 正常聊天
- [ ] Agent 能读取 skill，理解如何操作 draft.yaml 文件
- [ ] Agent 修改 draft.yaml 后，编辑器能刷新画布
- [ ] 再次打开 Chat 面板时复用已有实例
- [ ] 每个 user/team 有独立的 meta agent 实例
- [ ] Chat 面板可折叠，折叠状态持久化到 localStorage
