# sandbox-dsh — DeepSeek Harness 沙箱镜像

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`，官方 agent harness）
以 **docker 容器**形态接入 FenixAgent，**伪装为 ccb 引擎槽位**：主服务器、前端、权限链路均零感知，
实际执行的是容器内的 dsh ACP server。

## 工作原理

```
RCS 主服务器                    sandbox-dsh 容器
┌──────────────────┐   ACP   ┌──────────────────────────────────────┐
│                  │  WS/API │ bun acp-runtime.js (acp-link client) │
│ 按 ccb 槽位管理    │◄────────│  AGENT_TYPE=ccb                       │
│  生命周期/权限/会话 │         │      │ ccb handler (引擎命令经 env 注入)  │
└──────────────────┘         │      ▼                                │
                             │ node dsh-acp-wrapper.js               │
                             │  ① 读 .claude/settings.local.json     │
                             │     （ccb handler 写入的模型配置）        │
                             │  ② 生成 cordis.yml（llm-pi-ai route）  │
                             │  ③ exec dsh-acp-demo --config ...      │
                             └──────────────────────────────────────┘
```

伪装链路走「ccb 槽位」机制（`docker/sandbox-peri` 已切到 peri 原生节点，不再走该机制）：主服务器按 `AGENT_TYPE=ccb` 路由到
`createCcbHandler()`，ccb handler 在 prepareWorkspace 阶段把 Agent 的模型配置
（protocol / model / apiKey / baseUrl / prompt）写入
`<workspace>/.claude/settings.local.json` 与 `CLAUDE.md`，然后以
`RCS_CCB_COMMAND` / `RCS_CCB_ARGS` 指定的命令启动引擎——这两个键由容器内的 `acp-runtime`
（acp-runtime-cli）读取后注入 ccb handler（覆盖镜像 CMD 的 argv），属 daemon / 容器侧部署配置，
写在宿主 `.env` 里不起作用。

`dsh-acp-wrapper.js` 作为该命令的执行体，把 ccb 配置翻译成 dsh 的
`cordis.yml`（`llm-pi-ai` 自定义 provider route + `acp-agent`），再以
stdio 继承方式启动 `dsh-acp-demo`。API key 只经 `DSH_LLM_API_KEY` 环境变量
传给 dsh 进程，**不落盘**。

## 使用

> **本目录是 `docker/` 下唯一仍从源码构建的依赖目录**：CI（`.github/workflows/docker-publish-sandbox.yml`）
> 的 matrix 里没有 `dsh`，GHCR 上没有它的发布镜像，因此 compose 声明 `build:` 而不是 `image:`；
> 同族的 peri / ccb / opencode 都只引用发布镜像。补上发布链路后这里改成 `image:` 即可。

```bash
# 1. 填配置：cp .env.example .env，填 RCS_URL、RCS_SECRET、RCS_MACHINE_ID（唯一）
#    （随主服务一键启动时在 docker/deploy.env 打开 FENIX_FEATURE_SANDBOX_DSH=true，脚本会注入 RCS_URL）
# 2. 构建并启动
docker compose -f docker/sandbox-dsh/docker-compose.yml build
docker compose -f docker/sandbox-dsh/docker-compose.yml up -d

# 3. 主服务器上把该 machine 绑定到 Environment，Agent 正常配置模型即可
#    （模型支持 OpenAI 兼容端点或 Anthropic 协议，平台 provider 配置决定）
```

模型不需要在容器内配置：主服务器为 Agent 绑定模型后，ccb handler 会把配置
下发到 workspace 的 settings.local.json，wrapper 自动翻译。

## 网络接入清单

| 服务 | 接入 `fenix-server` | 理由 |
| --- | --- | --- |
| `sandbox-dsh` | 是 | 主动出网（容器内 acp-link 连主服务）、无入站流量，但要按服务名连主服务：同机一键启动时脚本注入 `ws://rcs:3000`，`rcs` 只在该网络内可解析，因此声明 `networks: [fenix-server]`（`external: true`）。代价是该网络内的 `postgres` / `redis` 对本容器也可达。 |

跨机时填主服务可达地址（端口即 `FENIX_HTTP_PORT`，默认 3001）；独立节点机器上先
`docker network create fenix-server`（只为名字解析），或改填宿主可达地址并删掉 `networks` 段换取彻底隔离。
宿主不发布任何端口。

## 数据与挂载

数据在 `./data/workspaces`（bind，相对本 compose 文件解析）；容器以 root 运行，其创建的文件属主为 root。
容器名固定为 `fenix-sandbox-dsh`（契约 §6.8）。

## 模型注入映射

| ccb settings（主服务器下发） | dsh cordis.yml |
|---|---|
| `modelType: openai` | `llm-pi-ai` route `api: openai-completions` |
| `modelType: anthropic` | `llm-pi-ai` route `api: anthropic` |
| `env.ANTHROPIC_MODEL` / `model` | `acp-agent.config.model` + `providers.<route>.models[0].id` |
| `env.ANTHROPIC_AUTH_TOKEN` / `OPENAI_API_KEY` | `DSH_LLM_API_KEY` 环境变量（apiKeyEnv 引用） |
| `env.ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` | `providers.<route>.baseURL`（空时回退官方默认） |
| workspace `CLAUDE.md`（Agent prompt） | `acp-agent.config.persona`（支持 `{{model}}`/`{{cwd}}` 模板） |

## 已知限制

- **dsh 目前是 developer preview**（官方明示将有破坏性兼容变更）。镜像固定
  `@deepseek-ai/dsh-acp-demo@0.1.0-rc.6`（注意 npm `latest` tag 停在旧版
  `0.0.1-rc.1`，升级时必须显式指定版本）。升级后需回归验证。
- **automation-only ACP server**：`session/update` 只发已提交的整块文本
  （`agent_message_chunk`），不是 token 级流式；reasoning / tool 过程不出现在
  relay 中。交互式聊天体验与 opencode/ccb 有差异。
- **不支持 MCP**：`session/new` 收到非空 `mcpServers` / `additionalDirectories`
  会返回 `invalidParams`。Agent 绑定 MCP 服务器时实例会启动失败，请勿绑定。
- **能力广告最小**：initialize 只广告纯文本 prompt 能力（无 fs/terminal/editor），
  前端按 capabilities 呈现的功能会少于 ccb。
- **权限策略固定**：composition 内 `approval.policy: never` + 沙箱
  `workspace-write`（bash/fs 限制在 workspace 内）。如需接入平台审批链路，
  需改造 wrapper 生成的 composition 并验证 `session/request_permission` 转发。
- **持久化压缩禁用**：容器内无 zstd 运行库，`persistenceCompression: none`。
- **单容器单会话行为**：dsh 支持多会话，但 acp-runtime 的 ccb 槽位按单会话
  模式工作（ccb handler 的新会话复用同一进程）。

## 与 docker/sandbox-peri 的差异

| | sandbox-peri | sandbox-dsh |
|---|---|---|
| 引擎 | Peri CLI（peri 原生节点，`AGENT_TYPE=peri`） | DeepSeek Harness（官方 ACP server） |
| 配置翻译 | peri handler 直写 `.peri/settings.json` + `.claude/settings.local.json` | ccb handler 写 ccb settings，wrapper 二次翻译为 cordis.yml |
| 输出粒度 | token 级流式 | 提交级整块文本 |
| npm 包 | 无（脚本安装） | `@deepseek-ai/dsh-acp-demo@0.1.0-rc.6` |
