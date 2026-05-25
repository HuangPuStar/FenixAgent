---
name: workflow-yaml-create
description: |
    创建符合项目 workflow-engine 规范的 YAML 工作流定义文件。当用户提到"创建工作流"、"写 workflow yaml"、"新建 workflow"、"工作流定义"、
    "workflow definition"、"add a workflow"、或需要在 workflow/ 目录下新建 .yaml 文件时，务必使用此 skill。
    也适用于用户要求修改、扩展已有工作流 YAML，或询问"怎么写 workflow"的场合。
---

# Workflow YAML 创建规范

本 skill 指导你为项目的 `workflow-engine` 包（`packages/workflow-engine/`）编写合法的工作流 YAML 文件。

## YAML 根结构

每个工作流 YAML 必须包含以下字段：

```yaml
schema_version: "1" # 必填，目前唯一合法值为 "1"
name: <string> # 必填，工作流名称（kebab-case 推荐）
description: <string> # 可选，一句话描述用途
params: # 可选，声明工作流参数
    <param_name>:
        type: string | number | boolean | object
        required: true | false
        default: <value>
secrets: # 可选，声明需要注入的密钥名称列表
    - API_KEY
    - DB_PASSWORD
timeout: <number> # 可选，工作流整体超时（秒）
nodes: # 必填，节点数组（至少一个节点）
    - ...
```

**要点**：

- `schema_version` 必须是字符串 `"1"`（不是数字 1）
- `name` 不能为空字符串
- `nodes` 必须是数组，不能为空
- 旧版格式（含 `kind` / `metadata` / `spec` 的 acpx-g 格式）已被废弃，不要使用

## 节点类型详解

所有节点共享以下基础字段：

| 字段          | 类型     | 必填 | 说明                                   |
| ------------- | -------- | ---- | -------------------------------------- |
| `id`          | string   | 是   | 节点唯一标识，建议使用下划线分隔（如 `gen_data`） |
| `type`        | string   | 是   | 节点类型枚举                           |
| `description` | string   | **是** | 节点描述，简要说明该节点的用途 |
| `depends_on`  | string[] | 否   | 前置依赖节点 ID 列表                   |
| `condition`   | string   | 否   | 执行条件表达式                         |
| `timeout`     | number   | 否   | 节点超时（秒）                         |
| `retry`       | object   | 否   | 重试配置 `{ count, delay?, backoff? }` |
| `env`         | map      | 否   | 节点级静态环境变量（shell/python 有效） |

> **⚠️ `description` 是强制必填字段。** 每个节点都必须写 `description`，简要说明该节点做什么。它会显示在编辑器的节点卡片上，是理解工作流的关键信息。省略 `description` 的 YAML 不合格。
>
> ```yaml
> # ❌ 错误 — 缺少 description
> - id: build
>   type: shell
>   command: make build
>
> # ✅ 正确
> - id: build
>   type: shell
>   description: "编译项目产物"
>   command: make build
> ```

### 数据传递方式（重要）

工作流引擎对数据传递有明确的规则，取决于节点类型：

**Shell 和 Python 节点**：使用 `inputs` 字段显式声明需要的上游数据。禁止在 `command` / `code` 中使用 `${{ }}` 模板。

- **Shell 节点**：`inputs` 中的值被注入为**环境变量**，命令中通过 `$VAR_NAME` 引用。
- **Python 节点**：`inputs` 中的值被注入为 **Python 变量**（自动生成前导赋值代码），代码中直接使用变量名。

**Agent、API、Audit 节点**：保留 `${{ }}` 模板语法，由调度器在执行前解析。

### 1. Shell 节点 — 执行命令行

```yaml
- id: build
  type: shell
  description: "编译项目产物"
  command: | # 必填，字符串或字符串数组
      cd repo && make build
  cwd: "./workspace" # 可选，工作目录
  inputs: # 可选，声明需要注入的环境变量
      BRANCH: params.branch        # params 引用
      REPO_DIR: nodes.checkout.output  # 上游节点输出
  env: # 可选，静态环境变量（与 inputs 共存）
      BUILD_MODE: release
  depends_on: [checkout]
  timeout: 300
  retry: # 可选
      count: 2
      delay: 3
      backoff: exponential # fixed（默认）或 exponential
```

**inputs 字段规则**：

- `inputs` 是 `Record<string, string>`，key 是环境变量名，value 是表达式路径
- 表达式路径支持：`params.xxx`、`secrets.xxx`、`nodes.<id>.output`
- 如果引用 `nodes.<id>` 则该节点**必须**在 `depends_on` 中声明，否则校验报 `INPUTS_MISSING_DEPENDENCY` 错误
- `inputs` 与 `env` 可以共存：`env` 存放静态常量，`inputs` 存放动态解析的上游数据
- 所有值统一转为字符串（对象/数组会 JSON 序列化）

**输出**：节点 stdout 即为输出。如果 stdout 是合法 JSON，下游可通过 `nodes.<id>.output.<field>` 访问具体字段。

### 2. Python 节点 — 执行 Python 脚本

```yaml
- id: process_data
  type: python
  description: "处理并转换数据"
  inputs: # 可选，声明需要注入的 Python 变量
      size: params.data_size       # → size = 50
      env_name: params.target_env  # → env_name = "staging"
      upstream: nodes.fetch.output # → upstream = json.loads('{"total":100}')
  code: | # 必填，Python 代码（inputs 变量可直接使用）
      import json
      print(f"Processing {size} records in {env_name}")
      data = upstream  # 已经是 Python 对象
      print(json.dumps({"count": len(data)}))
  requirements: # 可选，pip 依赖列表
      - requests
      - pandas
  cwd: "./workspace" # 可选
```

**inputs 注入规则**：

- 简单值（字符串/数字/布尔/null）→ Python 字面量赋值（`size = 50`、`name = "hello"`、`flag = True`、`val = None`）
- 复杂值（对象/数组）→ `json.loads('...')` 赋值（自动添加 `import json`）
- Python 代码中**直接使用变量名**，不需要 `os.environ` 或 `sys.argv`

### 3. Agent 节点 — 调用 AI Agent

```yaml
- id: review_code
  type: agent
  description: "AI 代码审查"
  prompt: | # 必填，支持 ${{ }} 模板变量
      Review the code changes in ${{ nodes.checkout.output.repo_dir }}.
      Focus on security issues.
  agent: opencode # 可选，指定 Agent 名称
  skill: code-review # 可选，预加载的 skill
  model: claude-sonnet-4-6 # 可选，覆盖 Agent 默认模型
  temperature: 0.7 # 可选，温度
  steps: 10 # 可选，最大步数
  depends_on: [checkout]
```

**要点**：

- `prompt` 支持 `${{ }}` 模板变量注入
- `agent` 不指定时使用默认 Agent

### 4. API 节点 — HTTP 请求

```yaml
- id: notify_slack
  type: api
  description: "发送 Slack 通知"
  url: "https://hooks.slack.com/services/xxx" # 必填，支持 ${{ }}
  method: POST # 可选，默认 GET
  headers: # 可选，值支持 ${{ }}
      Content-Type: "application/json"
      Authorization: "Bearer ${{ secrets.SLACK_TOKEN }}"
  body: | # 可选，支持 ${{ }}
      {"text": "Build completed: ${{ nodes.build.status }}"}
  depends_on: [build]
```

### 5. Audit 节点 — 人工审批门

```yaml
- id: approve_deploy
  type: audit
  description: "人工确认部署"
  display_data: # 可选，展示给审批人的信息
      title: "部署确认"
      environment: "${{ params.deploy_env }}"
  expires_in: 86400 # 可选，审批超时（秒），默认 24h
  depends_on: [build]
```

**要点**：触发后工作流进入 `SUSPENDED` 状态，等待外部审批回调。

### 6. Workflow 节点 — 子工作流引用

```yaml
- id: run_build
  type: workflow
  description: "执行构建子工作流"
  ref: ./build-lib.yaml # 必填，相对路径基于当前 YAML 所在目录
  params: # 可选，传递给子工作流的参数
      repo_url: "${{ params.repo_url }}"
      branch: "develop"
  ignore_errors: false # 可选，子流程失败时父节点是否仍然 completed
```

### 7. Loop 节点 — 循环执行

```yaml
- id: batch_process
  type: loop
  description: "批量处理数据"
  condition: "${{ nodes.process.status }} == 'success'" # 必填，do-while 条件
  max_iterations: 10 # 必填，最大迭代次数
  depends_on: [setup]
  body: # 必填，子 DAG
      nodes:
          - id: process
            type: shell
            description: "单批次处理"
            command: "python process.py --batch $BATCH_ID"
            inputs:
              BATCH_ID: params.batch_id
```

**要点**：

- `condition` 在每次迭代完成后求值（do-while 语义）
- 子 DAG 的节点 ID 与父 DAG 隔离（独立命名空间）

## 变量表达式语法

表达式语法取决于节点类型：

### inputs 表达式（Shell / Python 节点）

在 `inputs` 字段中使用点分路径，无 `${{ }}` 包裹：

| 表达式路径 | 示例 | 说明 |
|---|---|---|
| `params.xxx` | `params.branch` | 根参数引用 |
| `secrets.KEY` | `secrets.API_KEY` | 密钥引用（字符串值） |
| `nodes.<id>.output` | `nodes.check.output` | 上游节点完整输出（JSON 对象） |
| `nodes.<id>.output.<field>` | `nodes.check.output.count` | 上游节点输出的某个字段 |

**注意**：`nodes.<id>.output` 是已解包的 JSON 对象（如果上游输出是合法 JSON），不需要再加 `.json`。例如上游输出 `{"count": 10}`，则 `nodes.X.output` 就是 `{"count": 10}`，`nodes.X.output.count` 就是 `10`。

### ${{ }} 模板表达式（Agent / API / Audit 节点）

在 `prompt`、`url`、`headers`、`body`、`display_data` 等文本字段中使用 `${{ }}` 包裹：

| 命名空间 | 示例 | 说明 |
|---|---|---|
| `params.xxx` | `${{ params.branch }}` | 根参数引用 |
| `nodes.<id>.output.stdout` | `${{ nodes.checkout.output.stdout }}` | 节点标准输出（原始字符串） |
| `nodes.<id>.output.<field>` | `${{ nodes.build.output.artifact_path }}` | 节点 JSON 输出字段 |
| `nodes.<id>.status` | `${{ nodes.build.status }}` | 节点状态 |
| `secrets.KEY` | `${{ secrets.API_KEY }}` | 密钥引用 |

**支持的运算**：属性访问 `a.b.c`、比较 `==` `!=` `>` `<` `>=` `<=`、逻辑 `&&` `||` `!`、三元 `a ? b : c`、字符串拼接 `+`。

**不支持**：map/filter/reduce、函数调用、任意 JS 表达式。复杂数据变换应放到 Shell/Python 节点中处理。

## 依赖关系

- 无 `depends_on` 或 `depends_on` 为空的节点是起始节点（并行启动）
- Shell/Python 节点的 `inputs` 如果引用了 `nodes.<id>`，该节点**必须**在 `depends_on` 中声明，否则校验失败
- Agent/API/Audit 节点的 `${{ }}` 中引用的节点 ID 会被自动扫描并补充到 `depends_on`
- 环检测在解析阶段完成，有环会报错

## 节点 ID 命名建议

- 使用**下划线**分隔（如 `gen_data`、`calc_stats`），避免连字符
- 连字符在表达式路径中可能被解析器拆分，导致引用失败

## 文件存放位置

工作流 YAML 文件存放在项目根目录的 `workflow/` 目录下，文件名使用 kebab-case，扩展名 `.yaml`。

```
workflow/
├── simple-ci.yaml
├── build-lib.yaml
├── data-pipeline.yaml
└── notify.yaml
```

运行时 YAML 持久化到 `~/.agents/workflows/<teamId>/<workflowId>/` 目录。

## 完整示例

以下是一个包含多种节点类型的完整工作流，展示了 `inputs` 和 `${{ }}` 的正确使用方式：

```yaml
schema_version: "1"
name: data-pipeline
description: "数据生成 → 并行清洗/统计 → AI 分析 → 汇总报告"

params:
    data_size:
        type: number
        default: 50
    target_env:
        type: string
        default: staging

secrets:
    - SLACK_WEBHOOK

timeout: 300

nodes:
    # ① Python 节点：params → inputs（Python 变量注入）
    - id: gen_data
      type: python
      description: "生成模拟数据"
      inputs:
          size: params.data_size
          env_name: params.target_env
      code: |
          import json, random
          random.seed(42)
          records = [
              {"id": i + 1, "val": round(random.uniform(10, 500), 2), "cat": random.choice(["A", "B", "C"])}
              for i in range(size)
          ]
          print(json.dumps({
              "env": env_name,
              "count": len(records),
              "avg": round(sum(r["val"] for r in records) / len(records), 2),
          }))

    # ② Shell 并行 A：上游 output → inputs（环境变量注入）
    - id: calc_stats
      type: shell
      description: "计算统计指标"
      depends_on: [gen_data]
      inputs:
          DATA: nodes.gen_data.output
      command: |
          python3 << 'PYEOF'
          import json, os
          data = json.loads(os.environ['DATA'])
          print(json.dumps({"records": data['count'], "avg_val": data['avg']}))
          PYEOF

    # ② Shell 并行 B：同一上游 output → inputs
    - id: check_env
      type: shell
      description: "环境检查"
      depends_on: [gen_data]
      inputs:
          DATA: nodes.gen_data.output
      command: |
          python3 << 'PYEOF'
          import json, os
          data = json.loads(os.environ['DATA'])
          print(json.dumps({"environment": data['env'], "healthy": True}))
          PYEOF

    # ③ Agent 节点：保留 ${{ }} 模板语法
    - id: ai_analysis
      type: agent
      description: "AI 数据分析"
      prompt: |
          分析以下统计数据，给出洞察：
          统计: ${{ nodes.calc_stats.output.stdout }}
          环境: ${{ nodes.check_env.output.stdout }}
      agent: general
      steps: 5
      depends_on: [calc_stats, check_env]

    # ④ Shell 多源汇聚：两个上游 + params
    - id: final_report
      type: shell
      description: "生成最终报告"
      depends_on: [calc_stats, check_env, ai_analysis]
      inputs:
          STATS: nodes.calc_stats.output
          ENV_CHECK: nodes.check_env.output
          AI_OUT: nodes.ai_analysis.output
          TARGET_ENV: params.target_env
      command: |
          python3 << 'PYEOF'
          import json, os
          stats = json.loads(os.environ['STATS'])
          env = json.loads(os.environ['ENV_CHECK'])
          ai = json.loads(os.environ['AI_OUT'])
          target = os.environ['TARGET_ENV']
          print(json.dumps({
              "status": "PASS",
              "env": target,
              "records": stats['records'],
              "ai_summary": str(ai)[:200],
          }, ensure_ascii=False, indent=2))
          PYEOF

    # ⑤ API 节点：保留 ${{ }} 模板语法
    - id: notify
      type: api
      description: "发送完成通知"
      url: "${{ secrets.SLACK_WEBHOOK }}"
      method: POST
      headers:
          Content-Type: "application/json"
      body: |
          {"text": "Pipeline completed in ${{ params.target_env }}"}
      depends_on: [final_report]
```

## 自动验证工具

本 skill 附带一个 Python 验证器，自动检查上述所有规则：

```bash
# 验证单个文件
python3 .agents/skills/workflow-yaml-create/validate-workflow.py <file.yaml>

# 验证多个文件
python3 .agents/skills/workflow-yaml-create/validate-workflow.py workflow/*.yaml
```

验证器检查项：
- 根结构（`schema_version`、`name`、`nodes`）
- 每个节点必须有 `id`、`type`、`description`
- 各节点类型的必填字段（`command` / `code` / `prompt` / `url` / `ref` / `condition` + `body`）
- Shell/Python 节点的 `command`/`code` 中禁止使用 `${{ }}`
- `inputs` 中 `nodes.<id>` 引用必须在 `depends_on` 中声明
- `depends_on` 引用的节点必须存在
- 重复节点 ID
- 循环依赖
- 节点 ID 含连字符时发出警告

**创建或修改工作流 YAML 后，务必先跑验证器确认通过。**

## 编写检查清单

创建或修改工作流 YAML 后，逐项确认：

1. `schema_version: "1"` 存在且为字符串
2. `name` 非空
3. `nodes` 数组非空，每个节点都有 `id`、`type` **和 `description`**（遗漏任何一个都不合格）
4. 所有 `type` 值在枚举范围内：`shell` `python` `agent` `api` `audit` `workflow` `loop`
5. 每个 Shell 节点有 `command`、Python 节点有 `code`、Agent 节点有 `prompt`、API 节点有 `url`、Workflow 节点有 `ref`、Loop 节点有 `condition` + `max_iterations` + `body.nodes`
6. Shell/Python 节点通过 `inputs` 字段传递数据（不在 `command`/`code` 中使用 `${{ }}`）
7. Agent/API/Audit 节点通过 `${{ }}` 模板传递数据
8. `inputs` 引用 `nodes.<id>` 时，该节点在 `depends_on` 中声明
9. `${{ }}` 表达式引用的节点在 `depends_on` 链上（或会被自动补充）
10. 节点 ID 使用下划线分隔（避免连字符）
11. 运行 `python3 validate-workflow.py` 验证通过
