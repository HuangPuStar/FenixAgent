# compose-explorer —— 本地查看编排依赖关系

一个**本地只读**的小工具：把 `docker/` 下的 compose 编排读成一张依赖图，点节点就能看它对应的
`docker-compose.yml` / README / 初始化脚本。用来回答「谁依赖谁、谁在用共享的 postgres/mysql/rustfs、
哪些栈的开关是关着的」。

## 启动（本地 bun，不用 docker）

```bash
cd docker/compose-explorer
bun install          # 首次，只装一个依赖：yaml
bun run start        # 打开 http://127.0.0.1:7411/
```

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `FENIX_COMPOSE_EXPLORER_PORT` | `7411` | 监听端口 |
| `FENIX_COMPOSE_EXPLORER_HOST` | `127.0.0.1` | 监听地址。**改成非回环就会把仓库内文件全文暴露出去**（无鉴权），启动时会打印警告 |

改完 compose 后不用重启：点界面上的「重新扫描」（`POST /api/refresh`）会重新读盘。

## 图怎么读

- **节点** = 一个 compose 文件（主服务编排的两份文件：仓库根 `docker-compose.yml` 与 `docker/main/docker-compose.yml`、`docker/<name>/`、以及 `docker/<name>/<sub>/` 部署变体）。
  方框上的角标给出服务数与「同文件内的 depends_on 条数」；虚线框 = 该依赖目录在 `docker/deploy.env` 里是关闭的。
- **边** 有三种来源，颜色区分（图例在工具条右侧）：

| 边 | 含义 | 判定口径 |
| --- | --- | --- |
| include 引入 | 主服务编排的 `include:` 引入另一个文件 | compose 的 `include.path`（本仓只有两份主服务编排 → `docker/common`） |
| 共享网络 | 服务接入别的编排创建的 external 网络（跨项目 DNS 的唯一通路） | 非 external 声明网络的文件即创建者；接入方按服务逐个成边 |
| 服务引用 | 值里出现了别项目的服务名 | 扫 `environment` / `command` / `entrypoint` / `healthcheck` 里的 host 位置（URL、`host:port`、`*_HOST: name`），再按全局服务名索引 + 网络可达性过滤 |

- **`depends_on` 不画成边**：它是同项目内的启动顺序，不是跨项目依赖。同文件内的记为节点角标，
  跨文件（include 闭包内）的记在详情里。

- 红色虚线 = **依赖未满足**：目标服务受 profile 开关控制而当前没打开（例如 `ragflow → mysql` 需要
  `FENIX_FEATURE_MYSQL=true`）。
- 同属一个 compose 项目（root 及其 include 的文件）之间的引用不画跨项目边——它们本来就是同一项目内的
  服务名解析，用 include 边表达即可。

## 右侧面板

- **详情**：路径、项目名、开关状态、出/入依赖（逐条列出引用它的服务与证据）、服务清单（镜像、一次性服务、
  privileged、depends_on）、该目录的可读文件。
- **文件**：目录下的文本文件（compose / README / `.env.example` / Dockerfile / 脚本）。点服务行或证据行会
  直接跳到 `docker-compose.yml` 的对应段落并高亮。
- **告警**：跨项目引用是否可达、同名服务是否冲突（如 `opensandbox-server` 在 direct 与 tunnel 两个目录各有一份）、
  依赖目标是否被开关关闭、是否使用了命名卷（契约 §6.5 要求 bind）。

## 已知边界

- **不读 `.env`**：主服务对依赖的调用地址（`RCS_MODEL_GATEWAY_BASE_URL`、`HINDSIGHT_MCP_URL`、`GOTENBERG_URL` 等）
  在主服务 env（生产 `docker/main/.env`、dev 仓库根 `.env`，都不进版本控制）里，不在 compose 里，因此图上不出现「主服务 → 该依赖」的边。
  依赖接入 `fenix-server` 即表示它对主服务可见。
- 只有一个文件解析失败时只跳过它并打印，其余照常可视化；该文件仍会出现在文件列表里。
- 超过 400 KB 的文件只返回前 400 KB；超过 512 KB 的文件不进索引。
- 图与告警是**编排的视图，不是权威**：口径冲突时以 `docs/operations/docker-topology.md` 为准。

## 安全口径（改代码时不要放宽）

- 无写接口；只监听回环（默认）；`.env`、`*.key`、`*.pem` 等可能含密钥的文件**永不进索引**，
  未被索引的路径一律 404——路径穿越在读之前就被挡住。
- 文件内容按已扫描的 id 读取，不做任何路径拼接。

## 代码结构

```text
src/                 服务端（Bun.serve）
├── config.ts        路径、监听地址、只读文件白名单
├── scan.ts          compose 发现 + 可读文件索引
├── compose-doc.ts   YAML → 领域模型（服务、网络、include、行号区间）
├── references.ts    值里的 host 引用抽取与行号定位
├── deploy-config.ts docker/deploy.env 的 feature 开关
├── topology.ts      拓扑构建：四类边 + 告警
├── files.ts         按索引读取文件
├── http.ts          路由（静态资源 / /api/topology / /api/files / /api/file）
└── main.ts          入口
public/              前端（浏览器直接跑 .ts，由服务端用 Bun.Transpiler 即时转译）
├── main.ts          状态与渲染调度
├── model.ts         拓扑 → 渲染模型（边的聚合、搜索、布局坐标）
├── layout.ts        分层布局（Tarjan 收缩 + 最长路径 + 层内排序）
├── graph.ts         SVG 渲染、平移缩放、悬停高亮
├── panel.ts         详情 / 文件 / 告警三个 Tab
├── highlight.ts     逐行着色
└── types.ts         API 返回结构的镜像
```

调整布局或筛选口径改 `model.ts` / `layout.ts`；新增一类关系是 `topology.ts` 加一种 `EdgeKind`，
并在 `graph.ts` 的 `KIND_COLOR`、`panel.ts` 的 `KIND_LABEL` 与工具条的筛选里登记。
