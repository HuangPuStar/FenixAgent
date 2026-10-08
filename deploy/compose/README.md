# Compose 编排

本目录是本仓**自有服务**的编排归属：一个手写的基础编排 + 由模块 manifest 生成的依赖服务 overlay。

```text
deploy/compose/
├── base.yml                 # 手写：主服务进程 rcs + PostgreSQL（必需）+ Redis（--profile redis 可选）
└── overlays/<module>.yml    # 生成：模块声明的依赖服务（由 scripts/release.ts 从 fenix.module.ts 派生）
```

## 真相来源与生成关系

| 文件 | 性质 | 真相来源 | 消费方 |
| --- | --- | --- | --- |
| `base.yml` | **手写** | 本仓部署决定：镜像、端口、卷、启动命令 | `docker compose -f`；`deploy/manifests/profiles/ce.json` 把它的路径拼进启动命令 |
| `overlays/<module>.yml` | **生成**（勿手改） | 各模块 `fenix.module.ts` 的 `dependencyServices` | 同上 |

`base.yml` 手写的原因是它描述的东西**不是模块**：主服务进程没有 manifest（`apps/*` 的 manifest 只允许
`kind: "web-shell"`），`DATABASE_URL` / `RCS_REDIS_URL` 是宿主自有键（`apps/server/src/env.ts`）。
把它生成出来的唯一办法是再手写一份「主服务进程声明」，那是同一事实的第二份真相。

overlay 定义什么、不定义什么由模块声明决定：

- `orchestration: "compose-overlay"` 的服务在这里有 `services:` 定义（如 knowledge 的 Gotenberg）；
- `orchestration: "separate"` 的服务只作为注释与编排入口指针出现——它们的编排在别处（第三方产品的
  独立栈，或本仓独立部署单元如 `packages/opensandbox-cluster`），在这里再定义一遍就是同一栈的第二份真相。

生成或校验：`bun run release`（`--check` 校验漂移，`--profile <path>` 换装配 profile）。产物带「勿手改」头注释、
进版本控制，并且在 `biome.json` 的格式化面之外（`!!deploy/compose/overlays`）——漂移判定按字节进行，格式化会
被当成过期；改了模块的 `dependencyServices` 必须重新生成。

## 启停

cwd = 仓库根；相对路径按 compose 项目目录（编排文件所在目录）解析，所以基础编排里的仓库根写作 `../..`。

本目录只负责起容器：发布顺序是**先迁移、后部署**（容器内 `bun migrate.js` 早于应用进程），部署面先由
`bun run release` 生成/校验。把这条顺序一次跑完的入口是 `bun run release --deploy`——它按第 0 步部署面校验、
DDL 迁移、数据迁移、容器部署依次执行，失败即停；容器部署那一步用的就是本 profile 的 `compose.up`。完整顺序
与失败判定见 `docs/operations/upgrade.md` §1。

```bash
# 主服务 + 必需依赖（PostgreSQL）
docker compose -f deploy/compose/base.yml up -d --build

# 额外启用 Redis（可选能力：缓存与 Y.Doc 快照持久化）
docker compose -f deploy/compose/base.yml --profile redis up -d

# 叠加 knowledge 模块的依赖服务（Gotenberg）
docker compose -f deploy/compose/base.yml -f deploy/compose/overlays/knowledge.yml up -d

# 按装配 profile 启动：命令由 deploy/manifests/profiles/<profile>.json 的 compose.up 给出
```

**模块可独立启停**靠 overlay 的叠加与撤下实现：不叠加某个 overlay，就不启动该模块的依赖服务；模块缺失
只让对应能力降级，不阻断主服务——所有已声明服务的 `required` 都是 `false`（RAGFlow 缺失只损失检索、
Gotenberg 缺失回退 LibreOffice CLI、Hindsight 缺失表示记忆能力未启用、Cluster 缺失只影响沙盒管理面、
LiteLLM 缺失只让网关运行时整体不启用、npm 私有源缺失只让发布与预览失败），与
`apps/server/src/bootstrap/host-startup.ts` 对 `RAGFlow` 探活失败只告警的实测语义一致。

overlay 里刻意**不写** compose `profiles`：叠加/撤下 `-f` 已经是启停开关，再套一层 profile 会让
「按 profile 启动」与「按 `-f` 叠加」两套开关互相干扰，也会让 `depends_on: service_healthy` 这类跨文件
引用在 profile 未启用时报错。

## 边界：哪些编排不在这里

判定标准是**它启停的是不是本仓的模块**：

| 编排 | 位置 | 为什么 |
| --- | --- | --- |
| RAGFlow（`infiniflow/ragflow` 多容器栈） | `docker/ragflow/`、`docker/prod/docker-compose.ragflow.yml` | 第三方产品的独立栈，本仓只声明依赖与探针 |
| LiteLLM 模型网关 | `docker/litellm/`、`docker/prod/docker-compose.litellm.yml` | 同上；网关地址也可能指向托管服务 |
| Hindsight | `docker/hindsight/`、`docker/prod/docker-compose.hindsight.yml` | 同上 |
| OpenSandbox Cluster | `docker/opensandbox-cluster/` | 代码在本仓（`packages/opensandbox-cluster`），但它是独立部署单元而非 assembly 模块，且已有 `.env` / `frps.toml` / 运维脚本的既有用法 |
| Sandbox 执行节点（peri / dsh / ccb） | `docker/sandbox-*/` | 远端机器节点，按机器单独部署，不是主服务的依赖面 |
| npm registry（插件市场） | `docker/npm-registry/` | 第三方产品 |

已声明依赖服务的模块，其依赖关系**可被部署侧看到**：RAGFlow、LiteLLM 网关、Hindsight、OpenSandbox Cluster
与 npm 私有源都带编排入口与探针出现在 `deploy/manifests/modules.json` 与
`deploy/manifests/profiles/<profile>.json` 里（上表逐行就是各条声明的编排归属）。沙盒执行节点是例外：它们按
机器独立部署、不是主服务的依赖面，因此只出现在 `docker/sandbox-*/`，不进部署视图。

## 与既有编排的关系

仓库根 `docker-compose.yml`（本地开发：`docker compose up -d postgres`）与 `docker/prod/docker-compose.yml`
（生产：固定镜像 tag、`fenix-ver-net`）是**当前正在使用的入口**，本目录是这些编排的目标归属。两处并存
期间，主服务进程的改动需要同时落到 `base.yml` 与正在使用的那份；把存量入口收敛进本目录需要同步改
README、`docs/operations/deployment.md` 与 `docker/prod/README.md`，属独立任务。
