# Docker 编排体系

> **本文是 FenixAgent Docker 编排实现（目录契约自检、组合机制细则、feature 开关键表、env 规范、启动脚本用法、交付面）的权威文档**；
> 部署结构、方式与拓扑见 [Docker 部署架构与拓扑](../arch/26-deployment-topology.md)。
> 旧体系（`docker/prod/README.md`、`deploy/compose/README.md`、`docs/operations/deployment.md` §2.2–2.4 的描述）
> 已按 §12 退役并删除，本文不再有并存期。
>
> **状态：阶段 1、2、4 已完成；阶段 3 已跑通「启动 → down」，整机 prod 的迁移/健康自检待复跑**。已建：主服务编排——
> dev 形态是仓库根 `docker-compose.yml`、生产形态是 `docker/main/docker-compose.yml`（2026-10-08 拆分：dev 带 `build:`，
> 生产不构建、只用发布镜像、数据自包含；同 `name: fenix` + `fenix-server` + 固定版本镜像，基础服务 `postgres` /
> `redis` 由两份文件各自就地内联，没有 `docker/common/` 一类共享编排）、
> `docker/deploy.sh` + `docker/lib/config.sh`
> （含 `init` 与启动前必填项校验）、`docker/deploy.env.example`；`docker/` 下各依赖目录（含 `sandbox-opencode/`、
> `opensandbox-{cluster,server,server-tunnel}/`）均已补齐 §6 契约。
> 已验证：`bun run docs:build` 通过；`bun run precheck` 除 `package-tests` 中依赖**本地已建库**的一组用例
> （`workflow-v2` org-app，要求本地 Postgres 已迁移到 HEAD；本机库当时落后 13 个迁移）外全部通过——属环境状态，
> 与编排改动无关。
>
> **2026-10-08~14：共享实例收敛（2026-10-16 已整体退役，见下条）**。MySQL 从 `docker/workflow/` 上移到
> `docker/common/`（开关 `FENIX_FEATURE_MYSQL`），LiteLLM / RAGFlow / Workflow 的辅助服务随后收敛到 common，
> 库 / 桶由各自的**一次性初始化服务**负责（`litellm-db-init`、`ragflow-mysql-init` + `ragflow-s3-init`、
> `mysql-init` + `s3-init`）；RAGFlow 的对象存储同日回退为自栈实例（`ragflow-rustfs`——多桶模式下桶名是运行期
> UUID，共享实例上建不起隔离边界）。
> **2026-10-16 变更：共享基础设施退役，每个组件自带依赖实例**。`docker/common/`（含 `docker/common/data/`）整体
> 删除：它原先提供的 postgres（恒启动）与 redis / mysql / rustfs（各带一个 profile）随之退场，`FENIX_FEATURE_S3` /
> `FENIX_FEATURE_MYSQL` 两个开关与「共享实例」这个概念本身不再存在。现状：`docker/main/docker-compose.yml` 不再
> `include` 任何文件，**内联** `postgres`（恒启动）与 `redis`（`profiles: ["redis"]`）；`docker/ragflow/` /
> `docker/litellm/` / `docker/workflow/` 各带齐自己的依赖实例，三个目录重新自足——库 / 桶由本目录实例或本栈的
> 一次性服务落定，**没有跨项目等待**；`docker/workflow/` 的 `mysql` / `rustfs` 回到本目录但只在项目默认网络内，
> 因此不构成保留名冲突。细节见 §4、§5、§5.1、§6。
> **同日追加：`docker/` 下的依赖目录一律只引用发布镜像**——sandbox 的 `peri` / `ccb` / `opencode` 与
> `opensandbox-{cluster,server}` 之前都带 `build:`（本地/离线自建），现改为写死发布 tag（§6 规则 10、§13.15）；
> 唯一例外是 `docker/sandbox-dsh/`（GHCR 上没有它的发布镜像），本地自建改走各 README 里的 `docker build` 命令。
> **同日再追加：每份编排的 env 就是它自己目录下的 `.env`**——主服务的 env 从仓库根 `.env` 移到 `docker/main/.env`
> （与生产编排同目录，compose 的插值来源随之确定，目标机不再需要 `--env-file`）；生成器因此多产出一份
> `docker/main/.env.example`，`deploy.sh` 读的也是这一份（§4.2、§8、§11.2）。仓库根 `.env` 保留给 dev 形态。
> 没有跟着收敛的是**缓存**与 workflow 的 Elasticsearch，理由与代价见 §5.1。
> **2026-10-10 追加：新增依赖目录 `docker/peri-fuse/`**（LLM 观测，Langfuse 兼容实现，单容器 + 内嵌 Turso/SQLite，
> 无 ClickHouse / Redis / S3）。写入侧消费方是**Agent 进程**（本地执行在 `rcs` 容器内、沙箱节点在各自容器内），按
> `LANGFUSE_BASE_URL` 直连上报；读取侧由主服务经 `packages/resources/trace` 的只读薄层访问同一基址，供 Chat 的
> Trace 面板使用（薄层不代理任意路径，密钥只在服务端）。开关 `FENIX_FEATURE_PERI_FUSE`
> 已进生成物（§7），目录契约见 §6，操作面见该目录 README。
> **2026-10-14 追加：`docker/workflow/` 收敛为一次启动的自包含交付面**。上游 6 类初始化资产随
> `workflow-studio-server` 镜像交付（`/app/upstream-assets`），由新增的一次性服务 `assets-init` 展开到
> `docker/workflow/assets/`；Atlas 从 `init-mysql.sh` 里拆成独立的一次性服务 `atlas-init`（固定版本镜像，
> 去掉运行期 `curl atlasgo.sh`）；业务配置收敛为本目录唯一一份 `.env`（上游 `docker/.env` 不再参与）；
> 栈内数据（ES / redis / etcd / Milvus）从 `${WORKFLOW_STUDIO_DIR}/docker/data/` 收进 `docker/workflow/data/`；
> `WORKFLOW_STUDIO_DIR` 变量与上游源码 clone 一并退场。取舍、过渡门槛与代价见 §13.21。

## 1. 设计结论速览

| 决策 | 结论 |
| --- | --- |
| 编排归属 | 主服务与基础服务的编排分两份：**dev** = 仓库根 `docker-compose.yml`（带 `build:`，本地构建）；**生产** = `docker/main/docker-compose.yml`（无 `build:`，只用发布镜像）。`docker/<name>/` 是依赖目录，一个目录一个依赖 |
| dev / prod 分离 | 两份文件同项目名 `fenix`、同网络 `fenix-server`，**二选一运行**；生产入口是 `./docker/deploy.sh`（操作 docker/main 那份），dev 用根文件的裸 `docker compose` 命令 |
| 镜像 | 固定版本、写在 compose 文件里，不用环境变量插值；发布时同步更新两份编排的 `rcs` `image` 行（§4.2） |
| 网络 | 两层：依赖各自的**项目内网络** + 唯一的**主服务网络 `fenix-server`**（只让必要服务接入，§3） |
| 基础服务 | `postgres`（必需）+ `redis`（`FENIX_FEATURE_REDIS`）：**内联在主服务编排里**，dev 与生产各一份（数据落各自目录），不再有 `docker/common/`；其余依赖（MySQL / 对象存储等）由**每个组件自带实例**、互不影响（§5） |
| feature 开关 | 配置文件 `docker/deploy.env` 驱动；一个开关对应一个依赖目录（即“sub 插件 docker”），另有主服务编排里的可选服务开关（只有 `REDIS`） |
| 一键启动 | `./docker/deploy.sh up`：任意机器，只需要 docker + bash + 一份配置 |
| env 规范 | **每份编排的 env 就是它自己目录下的 `.env`**（主服务：生产 `docker/main/.env`、dev 仓库根 `.env`），模板 `.env.example` 与它同目录；文件内按「必需 → 可调 → 默认」三段排序；主服务自己的部署键与基础服务凭据在主服务 env，各依赖自带实例的凭据在该目录 `.env`（§8） |
| sandbox 执行节点 | 两者都支持：可随主服务一键起（feature 开关），也可按机器独立部署 |
| 旧体系 | `deploy/compose/`、`deploy/manifests/`、`scripts/release.ts` 的部署面生成、`docker/prod/` 全部退役（§12） |

## 2. 目标形态

```text
任意机器（只需 docker + compose ≥ 2.20 + bash）
  │
  ├─ docker/deploy.env ─ feature 开关（部署方维护，一份配置描述一台机器）
  ├─ docker/main/.env ── 应用配置、密钥与主服务编排的插值变量（与主服务编排同目录，不进版本控制）
  │
  └─ ./docker/deploy.sh up
       ├─ 主服务项目：docker compose -f docker/main/docker-compose.yml [--profile redis] up -d
       │    ├─ rcs                    主服务（生产：发布镜像的固定版本；dev 形态用仓库根 docker-compose.yml + build）
       │    ├─ postgres（必需）、redis（--profile redis）   基础服务，随本文件启动、数据落本目录 data/
       │    └─ 网络 fenix-server       主服务层，唯一共享网络（§3）
       └─ 对每个启用的依赖：
            docker compose -f docker/<name>/docker-compose.yml up -d
            （独立项目，自带依赖实例；只有需要与主服务互通的服务接入 fenix-server）

仓库根
├── docker-compose.yml          # dev 形态编排（带 build，本地构建；数据落仓库根 data/ 等）
├── .env / .env.example         # dev 形态的应用配置与密钥（根编排 include 的 docker/dev/ 组件也读这一份）
├── data/ workflow/ workspaces/ # dev 运行期数据（bind 挂载点，不进版本控制）
└── docker/
    ├── main/                   # 生产形态编排（无 build，只用发布镜像；内联 postgres / redis；env 为同目录 .env，数据落 main/ 下的同名目录）
    ├── deploy.sh               # 一键入口
    ├── lib/config.sh           # 配置解析、必填项校验、依赖发现（被 deploy.sh source；交付面必须带上）
    ├── deploy.env / .example   # 部署配置（只有开关，见 §7；.example 是生成物）
    ├── ragflow/  litellm/  hindsight/  peri-fuse/  npm-registry/  agent-sites/
    ├── workflow/               # Workflow V2 上游栈
    ├── sandbox-peri/  sandbox-dsh/  sandbox-ccb/  sandbox-opencode/   # 执行节点（引擎沙箱）
    ├── opensandbox-cluster/  opensandbox-server/  opensandbox-server-tunnel/
    └── compose-explorer/       # 本地只读的依赖关系可视化（bun run start；见该目录 README）
```

> `docker/compose-explorer/` 不进交付面：它是**开发期**查看编排关系的本地工具（只读扫描 compose 文件，把本文档
> 与部署脚本一并列为可读文件；不参与部署，`deploy.sh` 不引用它）。它按本文件与各目录 README 的口径推断跨项目
> 关系，因此它给出的图**是编排的视图，不是另一份权威**——冲突时以本文件为准。

数据落点一律「各自 compose 文件同级的 `./data/`」（§13.8）；每份配置描述一台机器，`docker/deploy.env` 就是那台机器的开关表。

三层职责：

| 层 | 内容 | 生命周期 |
| --- | --- | --- |
| 主服务项目 | 主服务 + 基础服务；部署入口 `./docker/deploy.sh`（操作 `docker/main/`），dev 备好仓库根 `.env`（填 `RCS_API_KEYS`）后 `docker compose up -d`（根文件；组件零配置）即最小可用集（rcs + postgres） | 与部署同生共死 |
| 依赖目录 | 可选能力的外部依赖（第三方栈或独立部署单元），即“sub 插件 docker” | 独立项目，可单独起停、单独升级 |
| 交付面 | `deploy.sh` + `deploy.env` + 上述文件 | 随版本发布 |

## 3. 网络分层

两层网络，职责不重叠：

| 层 | 网络 | 成员 | 可见性 |
| --- | --- | --- | --- |
| ① 项目内层 | 各 compose 项目的默认网络（Compose 自动创建，随项目名隔离） | 项目声明的全部服务 | 仅同项目内的服务互相可见 |
| ② 主服务层 | `fenix-server`（具名网络，主服务项目创建） | 主服务 `rcs`、主服务自带的 `postgres` / `redis`、各依赖中**需要与主服务互通**的服务 | 网络内全部容器互相可见（跨项目） |

成员判定标准（唯一）：**这个服务是否需要与主服务（或需要访问主服务的执行节点）直接通信。**

- 必须接入 ②：`rcs`；主服务自带的两个基础服务 `postgres` / `redis`（它们的服务名是 `fenix-server` 上的跨项目 DNS 名）；
  依赖的对外出口服务——RAGFlow 的 API 服务与同栈的 `gotenberg`、`litellm`、`hindsight`、`npm-registry`、`agent-sites`、
  平台观测入口 `otel-collector`（应用与浏览器同源代理的 OTLP 接收）和 `openobserve`（Collector 的存储出口，应用不直连）、
  观测服务 `peri-fuse`（上报方是 Agent 进程：本地执行在 `rcs` 容器内、沙箱节点在各自容器内，按服务名直连它）、
  Workflow 的 `coze-web`（唯一出口；Workflow 的其余服务——`coze-server` / `milvus` / `redis` / `elasticsearch` 与它自带的
  `mysql` / `rustfs`、以及所有一次性初始化服务——都只在项目默认网络内）；sandbox 节点与 opensandbox 管理面。
- 不得接入 ②：依赖栈内部的辅助服务——数据库与缓存（RAGFlow 的 `ragflow-mysql` / `ragflow-redis`、Workflow 的
  `mysql` / `redis`）、对象存储（S3 实现：`docker/ragflow/` 的 `ragflow-rustfs` 与 `docker/workflow/` 的 `rustfs`，
  以及同项目的一次性服务 `ragflow-s3-init` / `s3-init`）、消息队列（NSQ 类）、搜索引擎（`elasticsearch`）、
  向量库（`infinity` / `milvus`）等；它们只在 ① 内被本项目的出口服务访问。
- **每个组件的依赖实例都在它自己的项目里，没有共享实例**：因此没有再需要跨项目按名寻址的辅助服务，两个网络各管各的
  （每个栈的口令轮换、库空间占用、版本升级都不会外溢到别的组件）。

规则与理由：

1. ② 的成员是**最小必要集**。不让辅助服务进 ② 有三个直接收益：避免跨项目的服务名冲突（多个栈都有 `redis` / 对象存储）、
   收缩主服务的可达面（数据库与缓存不应被主服务或别的依赖直连）、依赖栈内部组件可自由替换（上游换实现不影响 ① 之外的任何人）。
   这三点也是**每个组件自带依赖实例**的理由：实例不进 ②，就不必为它保留任何跨项目名字（§5.1）。
2. **网络名唯一：`fenix-server`**。现状两个名字（`fenix-ver-net`、`fenix-server`）统一到后者——`docker/workflow/` 已按
   这套分层实践（只有出口 `coze-web` 显式接入共享网络，其余服务留在项目默认网络），本体系把它上升为所有依赖的通用契约。
3. 依赖项目里**只有显式声明 `networks` 的服务**进入 ②（以 `external: true` 引用）；未声明的服务自动留在 ①。
4. 接入 ② 的服务名是跨项目 DNS 名，必须**全局唯一**（契约见 §6）。
5. ② 由主服务项目定义并创建；依赖项目只引用，因此**依赖启动前主服务必须已启动**（顺序不变量，见 §9）。
6. 需要宿主直连的入口（调试端口、管理 UI）用端口发布表达，不通过网络表达。
7. **同名歧义**：一个容器同时挂在 ① 与 ② 上时，若两边都有同名服务，Docker 的容器 DNS 没有优先级约定（两个网络各自的
   记录都会被返回，取哪条取决于返回顺序）。所以：**`fenix-server` 上的保留名只有 `postgres` 与 `redis`**
   （由内联它们的主服务编排声明：dev 是仓库根 `docker-compose.yml`、生产是 `docker/main/docker-compose.yml`），
   依赖栈不得在自己的项目网络里占用这两个名字。规则是「**同一个服务名不得同时出现在 ① 与 ② 上**」，
   而不是某些名字本身被禁止：
   - `mysql` / `rustfs` **不是保留名**。`docker/workflow/` 的实例就叫 `mysql` / `rustfs`，它们只在项目默认网络内、
     从不出现在 `fenix-server` 上，因此与主服务的 `postgres` / `redis` 不构成冲突。
   - `docker/ragflow/` 的栈内实例一律带前缀（`ragflow-mysql` / `ragflow-redis` / `ragflow-rustfs`）：它是同时挂在
     两张网上的那一个（出口 `ragflow`），带前缀既避开两个保留名，也避开与后续组件同名。

## 4. 主服务编排（dev：仓库根 `docker-compose.yml`；生产：`docker/main/docker-compose.yml`）

两份文件的差异有两处：`build:` 段（仅 dev，用于本地构建）、数据挂载路径（dev 落仓库根，生产落 `docker/main/` 下）。
基础服务 `postgres` / `redis` 两份文件都就地内联（逐字同参、各自一套数据），`docker/main/` 不 `include` 任何文件。
`env_file` 两边都指向**同目录**的 `.env`（§8）——compose 的项目目录就是编排文件所在目录，所以这类相对
路径不需要区分 dev / prod。项目名、网络与服务定义保持一致，因此两者**二选一运行**——同项目名会互相接管容器。

dev 形态另外用 `include` 引入 `docker/dev/` 下的可选组件（litellm / ragflow / hindsight / agent-sites /
opensandbox），每份子文件的服务都带 `profiles: ["<组件名>"]`，因此裸 `docker compose up -d` 仍只起
`postgres` + `rcs`，加组件用 `docker compose --profile <组件名> up -d`。组件的键是**第三种 env 形态**
（§8），dev 根文件不在部署面 env 发现范围内（见 §8 与 `scripts/generate-env-example.ts`）。

### 4.1 结构（以生产形态 `docker/main/` 为例）

```yaml
name: fenix   # 固定项目名，不做插值：卷与容器都带项目名前缀，随目录名漂移等于换一套空数据

networks:
  fenix-server:
    name: fenix-server      # 主服务层网络（§3），唯一共享网络

services:
  postgres:      # 恒启动；数据落 ./data/postgres
    networks: [fenix-server]
  redis:         # profiles: ["redis"]；数据落 ./data/redis
    networks: [fenix-server]
  rcs:
    image: ghcr.io/huangpustar/fenixagent:sha-da5eb54   # 固定版本；发布时更新本行（dev 与生产两份同步）
    networks: [fenix-server]
    # …… 见 §4.3
```

- `name` 与 `image` 同属「写死在文件里、不做插值」的一类：交付面目录名、环境变量都不应改变数据身份。
- 基础服务与 `rcs` 同属本项目：`depends_on: postgres: { condition: service_healthy }` 直接可用。
- **本文件（与 dev 根文件）不 `include` 任何文件**：基础服务内联在其中，主服务编排自身不引用任何依赖目录，
  因此在没装任何依赖的机器上 `docker compose -f <主服务编排> config` 也能跑通。这条约束决定了
  「本栈的业务初始化归依赖自己」的形态（§5、§6）。
- `include` 机制仍被 **dev 根文件**使用：它引的是 `docker/dev/` 下的组件子编排，那些文件**可以**引用
  `docker/<依赖>/` 下的只读配置文件（`../ragflow/infinity_conf.toml`、`../opensandbox-cluster/frps.toml`），
  因为 dev 编排本来就只在仓库内使用、不随交付面外发。用过 `include` 的编排需要注意它需要 Compose ≥ 2.20.0，
  且被包含文件的相对路径**相对其自身目录**解析（Docker 官方语义）；脚本启动前检查 Compose 版本。
- 保留名只有 `postgres` / `redis`（§3 规则 7）：它们由本文件声明，依赖栈不得在 `fenix-server` 上同名。

### 4.2 dev / prod 分离机制

| 形态 | 命令 | 镜像来源 |
| --- | --- | --- |
| dev（容器） | `docker compose up -d --build`（仓库根文件） | 本地构建，tag 为 dev `image` 行的值 |
| dev（源码） | `docker compose up -d postgres` + `bun run dev` | 只起基础服务 |
| prod | `./docker/deploy.sh deploy` | `docker/main/` `image` 行写死的固定版本（`pull` 拉取，不构建） |

- **镜像固定版本**：`image:` 一律写死 tag（包括第三方依赖镜像），不使用环境变量插值、不使用 `latest`；
  发布新版本 = 更新这两行（进版本控制、可审计、可回滚），部署环境不参与版本决策。
- prod 交付面不含 Dockerfile 与源码，镜像必须先 `pull`；`build:` 段只在 dev 的根文件里。
- 手动操作生产编排时，插值来源是**它自己目录下的 `.env`**（`docker/main/.env`，模板 `docker/main/.env.example`，
  由 `./docker/deploy.sh init` 落成）：compose 的项目目录就是 `docker/main/`，因此下面这条命令在任意工作目录下
  等价，且不依赖仓库根 `.env`：
  `docker compose -f docker/main/docker-compose.yml up -d`。经 `deploy.sh` 时读的是同一份文件
  （脚本读入后导出为 shell 环境，优先级高于文件），不必也不会两处维护。

### 4.3 主服务定义（保持既有语义）

- 启动命令 `bun migrate.js && exec bun --no-install run dist/index.js`：DDL 先于应用进程，多副本靠 `pg_advisory_lock` 串行。
- `environment` 显式给出容器内连接串（如 `DATABASE_URL: postgres://rcs:rcs@postgres:5432/rcs`）：
  `environment` 优先级高于 `env_file`，这样 `.env` 里为源码运行准备的 `localhost` 连接串不会污染容器内解析。
- 卷：**全部 bind 到各自编排文件同级的 `./` 下**——`./data`（含 `./data/peri-home`，对应 Dockerfile 的 `VOLUME /root/.peri`）、
  `./workflow`、`./workspaces`。dev 落仓库根、生产落 `docker/main/` 下，两套数据互不影响。不声明任何命名卷：
  数据在交付面内，随目录整体搬迁/备份，不依赖 docker 全局卷。
- 健康检查 `GET /health`；日志 `LOG_FORMAT: json`；`env_file` 指向**同目录**的 `.env`（两份编排都写 `.env`，
  都是 `required: false`）：compose 的项目目录即编排文件所在目录，所以「哪份编排就吃哪份 env」由文件位置决定。
- 端口 `"${FENIX_HTTP_PORT:-3001}:3000"`；默认值在编排里，覆盖时写进同目录的 `.env`。

## 5. 基础服务与各栈自带的依赖实例

主服务自带的两个基础服务**内联在主服务编排里**（dev 是仓库根 `docker-compose.yml`、生产是 `docker/main/docker-compose.yml`）：

```yaml
services:
  postgres:       # 恒启动：DATABASE_URL 在宿主 schema 必填且无默认值（apps/server/src/env.ts），缺失即启动失败
  redis:          # profiles: ["redis"]   RCS_REDIS_URL；缺省时缓存回退进程内 Map、Y.Doc 快照不持久化
```

- 两份编排的这两个服务**逐字同参**，差异只有数据落点（dev 落仓库根 `./data/`，生产落 `docker/main/data/`）。
- 两者都接入 `fenix-server`（§3）：`postgres` 是主服务必需，且两个服务名都是跨项目 DNS 名（保留名，§3 规则 7）。
- `redis` 默认不发布宿主端口，仅网络内互通；`postgres` 的宿主端口由 `POSTGRES_PORT` 控制（本地源码开发需要，prod 可关）；
  而且**起 `redis` 不等于接上**：编排刻意不内联 `RCS_REDIS_URL`，要用缓存得在主服务 env 里写 `redis://redis:6379`。
- 凭据（`POSTGRES_PASSWORD`）从主服务 env 读取（dev 仓库根 `.env`、生产 `docker/main/.env`）：默认值只服务本地、
  生产必须替换；端口类键（`FENIX_HTTP_PORT` / `POSTGRES_PORT`）是主服务编排自己的插值变量，默认值写在编排里，
  需要修改时写进主服务 env，**不进** `docker/deploy.env`。
- 数据 bind 到各自编排同级的 `./data/`（`./data/postgres`、`./data/redis`），**不用命名卷**：命名卷会落到 docker
  全局目录（`/var/lib/docker/volumes/...`），打包交付面时容易漏、也看不出归属。
- 它们随主服务编排启动，插值环境就是该编排所在的项目：键取自该编排同目录的 `.env`（dev 自动加载仓库根 `.env`，
  生产自动加载 `docker/main/.env`）与 `deploy.sh` 导出的环境。
- **`redis` 的消费方只有 `rcs`**；两个依赖栈各自的缓存实例留在它们自己的项目里（见下）。

**其余依赖由每个组件自带实例，互不影响**：库 / 桶 / 缓存都随该目录的 compose 启动、只在该目录的网络内被访问，
一个栈的口令轮换、库空间占用与版本升级都不会外溢到别的组件。因此不再有「共享实例」这类东西，也没有与之配套的
`FENIX_FEATURE_S3` / `FENIX_FEATURE_MYSQL` 开关，也没有跨项目等待（§6）。
- **对象存储**：仓库里只有一套 S3 实现（RustFS，团队现网实现、S3 协议兼容），**不引入 MinIO**——两者都提供
  9000/9001 端口与同名 SDK 协议，同时存在只会让「用哪套」变成部署环境的隐性问题。RustFS 服务端 9000、控制台 9001；
  健康检查用 `curl -f http://localhost:9000/health`（本机已实测 200，`/health/ready`、`/health/live` 同样可用）。
  现有两份实例：`docker/workflow/` 的 `rustfs`（服务名就叫 `rustfs`）与 `docker/ragflow/` 的 `ragflow-rustfs`
  （带前缀，避开 `rustfs` 与后续组件同名）。两栈原先自带的 MinIO 都已在改造中删除（栈内 `mc` 初始化随之退场，
  建桶改由各自的一次性 `s3-init` 承担，见 §6）；现有实例都**只在本项目网络内**——不接 `fenix-server`、不发布宿主端口，
  因此不构成保留名冲突（§3 规则 7）。
- **`docker/ragflow/` 的对象存储为什么自带（理由与边界要照抄）**：栈内服务 `ragflow-rustfs`（`rustfs/rustfs:1.0.1`）
  只在 `ragflow-net`、不接 `fenix-server`、不发布宿主端口、服务名带 `ragflow-` 前缀（与栈内 `ragflow-redis` 同一处置）。
  **为什么**：RAGFlow 用多桶模式，桶名是运行期 UUID（每个知识库 `kb_id` / 每个文件目录 `parent_id` 一个真实桶）；
  若与别的栈共用一套实例，凭据就是全实例一对、实例侧也给不出「按消费方的桶策略」——那等于没有隔离边界。
  自带实例后，越权与跨栈桶命名空间两个问题同时消失。
- **两栈的「桶」形态不同，别照抄**：`docker/workflow/` 的桶是**固定名**（`opencoze` / `milvus`，由它的 `s3-init`
  创建并播种图标）；`docker/ragflow/` **没有桶可预建**——它不设上游的 `MINIO_BUCKET`（编排里也不再有任何替代键），
  桶名由知识库 / 文件目录（`kb_id` / `parent_id`）决定，是运行期才出现的 UUID，由 RAGFlow 首次写入时自建，
  `ragflow-s3-init` 因此只做**实例能力探测**（建自己的探测桶 → 读写 → 删对象 → 只删自己建的桶）。
  **不要给它补回 `MINIO_BUCKET`**：那会把对象键变成 `<逻辑桶>/<对象名>`，既有对象全部读不到——多桶布局与既有
  存量数据一致（升级前的编排**从未**设过它），搬迁时键不用重打。

### 5.1 实例归属与保留名

**保留名只有 `postgres` / `redis`**（主服务编排声明的两个基础服务，§3 规则 7）；`mysql` / `rustfs` **不再是保留名**：
它们现在只存在于各依赖自己的 Compose 项目里，从不出现在 `fenix-server` 上。逐项归属如下：

| 实例 | 归属 | 容器内地址（宿主端口） | 消费方 | 数据落点 |
| --- | --- | --- | --- | --- |
| `postgres` | 主服务编排，恒启动 | `postgres:5432`（`POSTGRES_PORT`，回环） | `rcs`（`DATABASE_URL`，库 `rcs`） | `docker/main/data/postgres`（dev 形态另有一份：仓库根 `./data/postgres`） |
| `redis` | 主服务编排，`FENIX_FEATURE_REDIS` | `redis:6379`（不发布宿主端口） | 只有 `rcs`（`RCS_REDIS_URL`）；未启用时缓存回退进程内 Map、Y.Doc 快照不持久化 | `docker/main/data/redis`（dev 形态另有一份：仓库根 `./data/redis`） |
| `litellm-postgres` | `docker/litellm/`，随该目录启动 | `litellm-postgres:5432` | 同目录的 `litellm`（库 `litellm`、角色 `litellm`，由镜像的 `POSTGRES_USER` / `POSTGRES_DB` 首启建好） | `docker/litellm/data/postgres` |
| `ragflow-mysql` | `docker/ragflow/`，随该目录启动 | `ragflow-mysql:3306` | 同目录的 `ragflow`（库 `rag_flow`、账号 `ragflow`，由镜像的 `MYSQL_DATABASE` / `MYSQL_USER` 首启建好） | `docker/ragflow/data/mysql` |
| `mysql` | `docker/workflow/`，随该目录启动 | `mysql:3306` | 同目录的 `coze-server`（库 `opencoze`，由 `mysql-init` + `atlas-init` 落定） | `docker/workflow/data/mysql` |
| `rustfs` | `docker/workflow/`，随该目录启动 | `rustfs:9000`（控制台 9001） | 同目录的 `coze-server` / `milvus`（桶 `opencoze` / `milvus`，由 `s3-init` 建） | `docker/workflow/data/rustfs` |
| `ragflow-rustfs` | `docker/ragflow/`，随该目录启动 | `ragflow-rustfs:9000` | 同目录的 `ragflow`（多桶模式，桶由 RAGFlow 运行期自建） | `docker/ragflow/data/rustfs` |

几个共同点：

- **每个实例只由本目录负责**：建库 / 建号 / 建能预建的桶与 schema 收敛都归持有它们的那一方
  （`docker/workflow/` 的 `assets-init` + `atlas-init` + `mysql-init` + `s3-init`、`docker/ragflow/` 的
  `ragflow-s3-init`，形态与约定见 §6）。`docker/litellm/` 与 `docker/ragflow/` 的 MySQL 连初始化服务都不需要：
  库与账号由镜像的 `POSTGRES_USER` / `POSTGRES_DB`、`MYSQL_DATABASE` / `MYSQL_USER` 在数据目录首次初始化时直接建好。
- **凭据按目录归属**（§8）：主服务自己的部署键与基础服务凭据（`POSTGRES_PASSWORD`）写主服务 env；每个自带实例的
  凭据是该目录的私有键——`docker/litellm/` 的 `LITELLM_DB_PASSWORD`、`docker/ragflow/` 的 `RAGFLOW_MYSQL_PASSWORD` /
  `RAGFLOW_MYSQL_ROOT_PASSWORD` / `RAGFLOW_S3_ACCESS_KEY` / `RAGFLOW_S3_SECRET_KEY`、`docker/workflow/` 的
  `WORKFLOW_MYSQL_PASSWORD` / `WORKFLOW_MYSQL_ROOT_PASSWORD` / `WORKFLOW_S3_ACCESS_KEY` / `WORKFLOW_S3_SECRET_KEY`，
  都定义在各自目录的 `.env`。实例默认不发布宿主端口（`MYSQL_HOST_PORT` 随 `docker/common/` 一起删除）。
- **没有跨项目依赖**：实例与消费方同属一个 Compose 项目，就绪由 `depends_on: <service>: { condition: service_healthy }`
  表达，一次性初始化服务用 `service_completed_successfully`（§6）。
- **Elasticsearch 仍在 `docker/workflow/`**：这是需求方的明确裁定（栈内服务的数据落点、健康检查与上游插件 / 索引
  模板都在该目录），**不是遗漏**——后续评审不要把它当成待办。

## 6. 依赖目录契约（`docker/<name>/`）

每个依赖一个目录，必须满足：

1. `docker-compose.yml` 是唯一入口；目录自包含（不引用其他依赖目录的文件与卷）。
2. **不与主服务 `-f` 叠加**：脚本以「独立项目」方式启动（`-f docker/<name>/docker-compose.yml` 单文件），
   因此文件内的相对路径相对自身目录解析，语义稳定；跨文件叠加会让相对路径基准变成第一个 `-f` 文件的目录，
   这是本体系明确排除的用法。
3. **网络按 §3 分层**：需要与主服务互通的服务接入 `fenix-server`（`external: true`），且服务名必须全局唯一
   （保留名只有 `postgres` / `redis`）；项目内部的辅助服务（数据库、缓存、对象存储、消息队列等）**不声明
   `networks`**，留在项目默认网络——自带实例正因为留在这里，才可以继续用 `mysql` / `rustfs` 这样的通用名（§3 规则 7）。
4. 宿主端口只绑回环（`127.0.0.1:<port>:<port>`）或不发布；只有面向外部用户的入口（如 `agent-sites` 的站点端口）
   才能绑 `0.0.0.0`，且必须可用环境变量覆盖。
5. 数据一律 bind 到**本文件同级的 `./data/`**（相对路径相对自身 compose 文件解析）；禁止命名卷——
   数据必须能从交付面直接看到、打包、搬迁，`docker volume ls` 里那些看不出归属的卷正是要避免的形态。
   已知例外只有 `docker/sandbox-peri/` 的工作区：它多绑了一条 `../../workspaces`，为的是同机开发时
   让节点与平台看到同一份文件（理由与独立部署的注意事项见该目录 README 的「数据与挂载」）。
6. `README.md`：用途、前置条件、配置项、网络接入清单（哪些服务进 `fenix-server`）、验证命令、升级方式
   （`docker/workflow/README.md` 是完整范例）。**自带依赖实例的目录还要写清：实例不可用时的表现与判定命令、
   本栈一次性初始化服务的就绪判据（`Exited (0)` + 日志末行），以及数据落点在本目录的哪个子目录。**
7. 幂等：重复 `up -d` 不破坏既有数据与状态。
8. 命名：项目名取目录名（`-f docker/ragflow/docker-compose.yml` → 项目 `ragflow`）；需要显式容器名时统一 `fenix-<name>`
   前缀（旧 prod 的 `fenix-ver` / `fenix-postgres-ver` 已随 `docker/prod/` 退役，主服务不设 `container_name`）。
9. **自带 env 文件**（规范见 §8）：`.env.example` 进版本控制、按三段式排序（必需 → 可调 → 默认）；
   独立部署时 `cp .env.example .env` 填完即可启动。
10. **只引用发布镜像**：`image:` 写死发布 tag（禁止 `latest` 与环境变量插值），不声明 `build:`——交付单元不带源码；
    本地自建改用 `docker build -f docker/<name>/Dockerfile …`（命令在各目录 README）。唯一例外是 `docker/sandbox-dsh/`
    （GHCR 上还没有它的发布镜像，见 §13.15）。**版本键例外**（2026-10-10 登记）：`image:` 行可以写成
    `${<NAME>_VERSION:-<缺省 tag>}`——缺省值仍在 compose 里（git 里看到的就是默认要跑的版本），部署方在**该依赖自己的**
    `.env` 覆盖它，键不进 `docker/deploy.env`（§7）；已登记：`docker/peri-fuse/` 的 `PERIFUSE_VERSION`。

### 一次性初始化服务（建本栈的库 / 账号 / 桶的目录必备）

每个组件自带的实例只提供「实例 + 库 / 账号」：`docker/litellm/` 与 `docker/ragflow/` 的 MySQL 由镜像的
`POSTGRES_USER` / `POSTGRES_DB`、`MYSQL_DATABASE` / `MYSQL_USER` 在数据目录首次初始化时建好，连初始化服务都不需要；
而**上游 schema 与能预建的桶**必须由该目录自己在**栈内的一次性服务**里落定。现有五例：
`docker/workflow/` 的 `assets-init`（把随 server 镜像交付的初始化资产展开到宿主，见 §13.21）、`atlas-init`（固定版本
Atlas 镜像做 schema 收敛）、`mysql-init`（`init-mysql.sh`）与 `s3-init`（`init-s3.sh`），
以及 `docker/ragflow/` 的 `ragflow-s3-init`（`init-s3.py`）。其中 `ragflow-s3-init` 形态特殊，评审时不要照抄成通例：
多桶模式下它**没有可预建的桶**，只建自己的探测桶做实例能力探测（见 §5）。**另有两处不挂独立脚本的例外**
（2026-10-14 登记）：`assets-init` 只做「清空 → 拷贝 → 写来源标记」四行文件操作、没有分支诊断，逻辑写在
`docker/workflow/docker-compose.yml` 的 `command` 里；`atlas-init` 的镜像是 distroless、没有 shell，参数只能直接给
（两者理由见 §13.21）。

**已知例外一处**（2026-10-12 登记）：`docker/git/` 不设一次性初始化服务，它的库与角色由运维按该目录 README 的
显式步骤在启动前创建——共享实例往往早已初始化，`docker-entrypoint-initdb.d` 那时不再执行，而库必须存在于 Forgejo
首次启动之前（它自己建表与迁移，连不上库就直接退出），建库与启动 Forgejo 因而是一个部署动作的两个步骤，不拆容器。
代价是幂等与阶段化诊断由 README 的运维步骤承担，没有可复跑的栈内服务；加新的同类例外需要同样明确的裁定与理由。

新增或改动这类服务时逐条核对：

1. **栈内一次性服务 + 独立脚本文件**：服务定义在消费方自己的 compose 里（`restart: "no"`，跑完即退出），
   逻辑放同目录的独立脚本，**不内联进 compose 的 `command` / `entrypoint`**——脚本有分支与失败诊断，内联进 YAML
   标量既难 review，也容易被折叠规则改写（折行会把注释与后续语句并到同一行），脚本里的 shell 变量还会被 compose
   的插值吃掉。脚本是**交付面文件**，随目录一起交付。
2. **`:ro` 只读挂载 + 显式覆盖 `entrypoint` + `create_host_path: false`**：只读挂载（不依赖宿主的可执行位），
   显式覆盖 `entrypoint`（这些镜像自带的入口会把参数当自己的启动参数劫持掉），`create_host_path: false`
   让脚本缺失时 compose 直接报错，而不是静默建出一个同名**目录**再以退出码 127 失败。
3. **幂等**：重跑只做「已存在则跳过 / 同步口令」，不动既有数据与对象（`CREATE ... IF NOT EXISTS`、`PUT /<bucket>`
   把 409 当通过）。这样「改配置后重跑一次」就是收敛路径，不需要进库手工改。
4. **阶段化诊断**：每一步有稳定的阶段前缀（各目录用 ①②③…），失败时给出**原始报错 + 判定分支**（认证失败还是
   实例不可达、是配置没打开还是解析不到服务名），并以非零退出码结束；日志末行就是结论，排障不必从堆栈倒推。
5. **只挂它需要的那张网**：只访问本栈实例的初始化服务只需项目默认网络，不接 `fenix-server`——接入面越小，
   跨项目 DNS 名越不容易撞车。
6. **启动顺序全在项目内表达**：实例与它的消费者同属一个项目，因此两层就绪都能直接写——先靠
   `depends_on: <service>: { condition: service_healthy }` 等实例（健康检查要用真实查询：workflow / ragflow 的
   MySQL 都用 `SELECT 1` 而不是 `mysqladmin ping`，后者在口令不对时同样返回成功，会让「口令改了但数据目录还是旧的」
   这类漂移不暴露），再由栈内主服务依赖**初始化服务的完成**：
   `depends_on: <init>: { condition: service_completed_successfully }`。**跨项目的 `depends_on` 不成立**（Compose 只
   允许依赖本项目内已定义的服务名，写别的项目的服务名直接报 `depends on undefined service …`，`litellm`、`ragflow`、
   `workflow` 三处都实测确认过，加 `required: false` 也一样）——本体系因此不再需要跨项目等待，这正是不共享实例的收益之一。
7. **失败不静默**：初始化服务非零退出 → 依赖它的栈内服务不启动（`docker compose ps` 里缺位或反复重启），
   `up -d` 的退出码本身不足以下结论——判定一律是「`docker ps -a` 里 `Exited (0)` + 日志末行的完成行」。

### feature 对照表

| 开关（`FENIX_FEATURE_<NAME>`） | 目录 | 平台能力 | 关键配置 |
| --- | --- | --- | --- |
| `RAGFLOW` | `docker/ragflow/` | knowledge 检索 + Office 转 PDF（gotenberg 服务并入本目录） | `RAGFLOW_API_URL` / `RAGFLOW_API_KEY` / `GOTENBERG_URL`；MySQL（`ragflow-mysql`）、Valkey 与对象存储（`ragflow-rustfs`）**都是本栈自带**，不依赖别的目录，也没有对应开关（§5） |
| `LITELLM` | `docker/litellm/` | model-management：模型网关 | `RCS_MODEL_GATEWAY_*`；库是栈内的 `litellm-postgres`（本栈自带，库与角色由镜像首启建好） |
| `HINDSIGHT` | `docker/hindsight/` | memory：长期记忆 | `HINDSIGHT_MCP_URL`、`DASHSCOPE_API_KEY` |
| `OTEL_COLLECTOR` | `docker/otel-collector/` | 平台标准观测采集与有界持久队列 | `OO_OTLP_ENDPOINT` / `OO_AUTH_HEADER` / 真实主机身份；不自动启用 OO |
| `OPENOBSERVE` | `docker/openobserve/` | 日志、指标、链路存储 | 管理初始化信息；采集凭据只给 Collector |
| `PERI_FUSE` | `docker/peri-fuse/` | agent-config：Agent 观测透传（Trace 上报；主服务不访问本服务） | `LANGFUSE_BASE_URL` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` |
| `NPM_REGISTRY` | `docker/npm-registry/` | plugin-market：元数据源 | `PLUGIN_MARKET_REGISTRY_*` |
| `AGENT_SITES` | `docker/agent-sites/` | agent-config：站点部署 | `AGENT_SITES_MASTER_KEY` 等 |
| `WORKFLOW` | `docker/workflow/` | workflow-v2 | `WORKFLOW_STUDIO_TAG` / `WEB_LISTEN_ADDR`（单份 `.env`）；MySQL 与对象存储（栈内 `mysql` / `rustfs`）**都是本栈自带**，初始化资产随 server 镜像交付、由 `assets-init` 展开（§13.21），另有前置条件（见该目录 README） |
| `SANDBOX_PERI` / `SANDBOX_DSH` / `SANDBOX_CCB` / `SANDBOX_OPENCODE` | `docker/sandbox-*/` | sandbox 执行节点 | `RCS_URL` / `RCS_SECRET` / `RCS_MACHINE_ID` |
| `OPENSANDBOX_CLUSTER` | `docker/opensandbox-cluster/` | sandbox 管理面 | `FRP_PUBLIC_ADDRESS` / `FRP_TOKEN` / `CLUSTER_SERVICE_API_KEY` / `SERVER_API_KEY_ENCRYPTION_KEY` |
| `OPENSANDBOX_SERVER` | `docker/opensandbox-server/` | sandbox 执行面（DinD 服务端） | `OPENSANDBOX_SERVER_PORT` 等，无必需键 |
| `OPENSANDBOX_SERVER_TUNNEL` | `docker/opensandbox-server-tunnel/` | sandbox 执行面（frpc 隧道） | 无插值键（配置在 `frpc.toml`） |
| `GIT` | `docker/git/` | common Git / tickets：仓库与工单的事实源（Forgejo） | `AOS_GIT_CONFIG_FILE` / `AOS_GIT_FORGEJO_URL`、`FORGEJO_DB_PASSWORD`；**依赖共享实例** `postgres`（库与账号由运维显式初始化，见该目录 README） |

`docker/opensandbox-server-tunnel/` 与 `opensandbox-server` 同镜像、只引用发布 tag，不声明 `build:`（§13.15）；
本地自建时在 `docker/opensandbox-server/` 的 Dockerfile 上打同一 tag（见该目录 README），两个目录的 `image:` 行必须同 tag。

`docker/opensandbox-cluster/deploy/` 是**另一个部署单元**（独立沙盒机三合一编排），自带 `opensandbox` 网络、
不接 `fenix-server`，因此不参与本表的 feature 开关。

脚本不编排、也没有开关的目录：现在没有。基础服务 `postgres` / `redis` 是主服务编排**内联**的服务（不对应目录），只由主服务可选服务开关 `FENIX_FEATURE_REDIS` 门控 `redis`（`postgres` 恒启动）。除此之外，**`docker/` 下每个带 `docker-compose.yml` 的目录都应有同名开关**。

主服务可选服务开关与目录开关是同一套语义（都写进 `docker/deploy.env`、都映射到 `--profile`），区别只在「没有
对应目录」：它由主服务编排里那个服务的 `profiles` 提供（现在只有 `redis` 一个），脚本的 `MAIN_OPTIONAL_FEATURES`
与 `scripts/lib/env-example-spec.ts` 的 `MAIN_FEATURE_SWITCHES` 两处必须同时登记（生成器测试逐项比对）。
**开关之间不自动联动**：一个开关只负责它自己那个目录（打开 `FENIX_FEATURE_WORKFLOW` 不会顺带起别的目录）；
每个目录自带的实例随它一起启动，因此不存在「忘了先打开某个共享服务开关」这类失败模式。

## 7. `docker/deploy.env`（配置文件）

```bash
# ── 依赖开关：一个开关对应一个 docker/<name>/，未写即关闭 ──
FENIX_FEATURE_RAGFLOW=false
FENIX_FEATURE_LITELLM=false
FENIX_FEATURE_HINDSIGHT=false
FENIX_FEATURE_NPM_REGISTRY=false
FENIX_FEATURE_AGENT_SITES=false
FENIX_FEATURE_WORKFLOW=false
FENIX_FEATURE_SANDBOX_PERI=false
FENIX_FEATURE_SANDBOX_DSH=false
FENIX_FEATURE_SANDBOX_CCB=false
FENIX_FEATURE_SANDBOX_OPENCODE=false
FENIX_FEATURE_OPENSANDBOX_CLUSTER=false
FENIX_FEATURE_OPENSANDBOX_SERVER=false
FENIX_FEATURE_OPENSANDBOX_SERVER_TUNNEL=false
FENIX_FEATURE_PERI_FUSE=false
FENIX_FEATURE_GIT=false

# ── 主服务可选服务（随主服务项目启动，不对应目录）──
FENIX_FEATURE_REDIS=false
```

端口等主服务编排自己的插值变量不在这里：默认值写在 `docker/main/docker-compose.yml`，需要修改时写进
`docker/main/.env`，由 Compose 从项目目录自动读取。

规则：

- 键名规则：目录名转大写、`-` 换 `_`（`sandbox-peri` → `FENIX_FEATURE_SANDBOX_PERI`）。
- **未知开关是错误**：脚本发现 `FENIX_FEATURE_*` 没有对应目录或保留名时直接报错退出，防止拼写错误静默失效。
- 默认全部关闭；`postgres` 恒启动，`redis` 是主服务编排里唯一带 profile 的可选服务（`FENIX_FEATURE_REDIS`）。
  开关只负责「起哪些服务」，**不做目录之间的自动联动**（理由见 §6 末）。
- **镜像键不在这里**：版本固定写在各 compose 的 `image:` 行（§4.2）；`docker/deploy.env` 里出现镜像键即视为设计漂移。
  登记例外是**版本键**（§6 规则 10）：`image:` 行可用 `${<NAME>_VERSION:-<缺省 tag>}`，该键写进**依赖自己的** `.env`，仍不进本文件。
- 密钥**不进** `docker/deploy.env`（它进版本控制，模板为 `docker/deploy.env.example`）；密钥只进主服务 env
  （`docker/main/.env`，dev 是仓库根 `.env`）。
- `docker/deploy.env.example` 是**生成物**（`bun run scripts/generate-env-example.ts`，与 `.env.example`、
  `docker/main/.env.example` 同批产出）；开关清单以脚本发现的目录为准，模板只负责把
  清单落成文件，不手工维护。
  上面这份示例的开关名单与生成物一致（16 个：15 个目录开关 + `REDIS`），核对方式：
  `grep -E '^# FENIX_FEATURE_[A-Z0-9_]+=' docker/deploy.env.example | sort` 得到的键名集合与上面的名单相同。
- **配置文件解析**（脚本行为，见 §9）：默认读与脚本同目录的 `docker/deploy.env`；它不存在而同目录恰好只有
  一份 `*.env` 时用那一份（部署方常按机器命名，如 `prod.env`）；有多份则报错列出、要求 `--config` 指定，不替你猜。
  所以「一份配置描述一台机器」= 把那份文件放进 `docker/`。

为什么是 `KEY=VALUE` 而不是 YAML / JSON：

- 目标机只保证 docker + bash，逐行 `KEY=VALUE` 解析即可读（脚本**刻意不用 `source`**：source 会展开值里的
  `$`、反引号，密钥可能被静默改写），零额外解析依赖；
- 与 Compose 的变量插值同源，脚本读到的值就是 compose 读到的值；
- 可注释、可 diff，能被 secret 管理系统按行替换。

## 8. env 文件规范

配置分四处，职责不重叠；**同一个键只在一处定义**，避免漂移。**每份编排的 env 就是它自己目录下的 `.env`**——
compose 的项目目录 = 该 compose 文件所在目录，变量插值与 `env_file` 都读这一份（§4.3）：

| 位置 | 作用域 | 模板（进版本控制） | 运行时文件 |
| --- | --- | --- | --- |
| `docker/deploy.env` | 部署开关（依赖目录与主服务可选服务），不承载其它组件的取值 | `docker/deploy.env.example` | `docker/deploy.env` |
| `docker/main/.env` | 主服务（rcs）的应用配置与密钥 + 主服务**自带基础服务**的凭据（`POSTGRES_PASSWORD`）；也是主服务编排的插值来源（含 `FENIX_HTTP_PORT` / `POSTGRES_PORT`） | `docker/main/.env.example` | `docker/main/.env` |
| 根 `.env` | 只服务 dev 形态：根 `docker-compose.yml`（含它 include 的 `docker/dev/` 组件）与 `bun run dev`（Bun 自动读仓库根） | `.env.example` | `.env` |
| `docker/<name>/.env` | 该依赖的私有键，含它**自带实例**的凭据（`LITELLM_DB_PASSWORD`、`WORKFLOW_MYSQL_*` 等） | `docker/<name>/.env.example` | 同目录 `.env` |

**dev 组件（`docker/dev/docker-compose.<组件>.yml`）是上表之外的另一种形态：它不设任何 env 文件。**
键全部写成 `${VAR:-默认值}` 内联在编排里，
**没有** `.env.<组件名>` 文件，也没有 `cp` 步骤。插值来源仍是**项目目录的 `.env`**（= 仓库根 `.env`）——
所以想改任何组件的默认值，都在仓库根 `.env` 写同名键，一个入口。默认值只服务本地、不安全，
compose 注释里逐条注明生产必须覆盖。这一形态不适用于依赖目录与主服务编排：那两处按 §8 的
三段式与 `${VAR:?}` 执行。

dev 根文件**不在部署面 env 发现范围内**（`scripts/generate-env-example.ts` 的 `DEPLOY_SURFACE_FILES`）：
它内联默认值、含组件专用键，不参与「两份主服务编排的插值键必须一致」的校验，新增、改名、删除键都不需要
登记或重新生成。生产面（`docker/main/docker-compose.yml`）的插值键由 `DEPLOY_INTERPOLATION_KEYS` 登记，
取值写进主服务 env；`docker/deploy.env.example` 只产出开关。

`postgres` / `redis` 内联在主服务编排里、不设自己的 env 文件：插值由主服务那一次 `docker compose` 调用决定
（dev 读仓库根 `.env`，生产读 `docker/main/.env`；经 `deploy.sh` 时由脚本把主服务 env 导出为 shell 环境），
键只能来自主服务 env（见 §5）。各依赖目录**自带的实例**（`docker/litellm/` 的
`litellm-postgres`、`docker/ragflow/` 的 `ragflow-mysql` / `ragflow-rustfs`、`docker/workflow/` 的 `mysql` /
`rustfs`）反过来都由它自己目录的 `.env` 插值：实例、凭据、消费方同处一个项目，键不跨目录读。

规则：

1. **每个带编排的目录自带一份 env 文件**：`.env.example` 随目录进版本控制，列出该目录要配的全部键（主服务那份
   是应用声明面全量键，依赖那份是该依赖全部可配置键）；部署方用 `./docker/deploy.sh init` 一次性落成，或在该目录内
   `cp .env.example .env`。所有 `.env` 一律被忽略——`.gitignore` 的 `.env` 规则匹配任意深度（已用
   `git check-ignore` 实测 `docker/ragflow/.env`、`docker/main/.env`、`.env`），密钥永不进版本控制。
   `init` 只创建缺失的文件，已存在的一律跳过。
2. **文件内按必需性排序**（硬规范，评审时逐文件核对）：
   - **顶部：必需项**——无默认值，缺失即启动失败；compose 里一律写 `${VAR:?<缺失说明>}`，报错必须能回答
     「缺什么、去哪填」（空字符串同样触发报错，`:?` 把空值视为未设置）。
   - **中部：部署可调项**——有默认值，但按部署形态通常需要改（端口、镜像 tag、对外地址）。
   - **底部：默认项**——有安全默认值，通常不需要改（超时、重试、内部路径、调优参数）。
   - 三段用注释分隔；每个键上方一行注释：用途 + 必需性（必需／默认值）+ 缺失或改错的后果。
3. **键不重复定义**：每个键只属于一个所有者——主服务自有部署键与主服务自带基础服务的凭据（`POSTGRES_PASSWORD`）
   在主服务 env（生产 `docker/main/.env`、dev 仓库根 `.env`）与 `docker/deploy.env`；各依赖目录自带实例的凭据
   （`LITELLM_DB_PASSWORD`、`RAGFLOW_MYSQL_*` / `RAGFLOW_S3_*`、`WORKFLOW_MYSQL_*` / `WORKFLOW_S3_*`）在该目录
   自己的 `.env`。两侧不交叉，同一个键不出现两份拷贝。
   - **仍有一类「两侧必须同值」的键**：如 `docker/litellm/.env` 的 `LITELLM_MASTER_KEY` 与主服务 env 的
     `RCS_MODEL_GATEWAY_ADMIN_KEY`，取值各写各的目录、值必须一致；随主服务启动时由脚本把主服务 env 导出进
     环境（规则 5），两侧读到同一份。
   - **两个例外是 `RCS_URL` 与 `RCS_SECRET`**，它们都不由主服务 env 供给：
     `RCS_URL` 是节点侧的键，唯一读取点是容器里的 `acp-runtime-cli`，主服务进程不消费它，因此不在主服务 env
     模板里（键归节点目录的 `.env`）；`RCS_SECRET` 在主服务侧叫 `REGISTRY_SECRET`，注册是否通过由后者决定。
     因此脚本对声明这两个键的依赖按同机语义注入 `ws://rcs:3000` 与 `REGISTRY_SECRET`
     （依赖自己的 `.env` 填了则以它为准），独立部署时才在该依赖的 `.env` 里填真实地址与同值密钥。
     注入是脚本行为，所以同机与独立两条路径都能通过同一套 `${VAR:?}` 校验。
4. **容器内地址不做同名插值**：容器内的连接地址（如 rcs 的 `DATABASE_URL`）在 compose 里写显式值，不写成
   `${DATABASE_URL}`——主服务 env 里为源码运行准备的 `localhost` 值一旦经 shell 环境进入插值，会把容器内地址
   污染成本机地址。
5. **加载与优先级**：
   - `docker compose -f <compose 文件>`（单文件）的项目目录 = 该文件所在目录，compose 自动读取同目录 `.env`
     作插值——主服务（root / `docker/main/`）与各依赖目录都由此天然生效、互不干扰，不需要 `--env-file`。
   - `docker/deploy.sh` 启动时把主服务 env（`docker/main/.env`）与 `docker/deploy.env` 导出为 shell 环境：**shell 环境优先于任何 `.env` 文件**，
     于是「随主服务启动」与「独立部署」两条路径下、「两侧必须同值」的键（规则 3）取值一致且可预期（同名时依赖
     目录 `.env` 里的值在脚本路径下被主服务导出的值覆盖）。
   - 注意：项目目录的 `.env` 只参与**变量插值**，不会自动注入容器；需要进入容器环境的键必须在 compose 里用
     `environment:` 或 `env_file:` 显式引用。
6. **独立部署自足**：依赖目录的 `.env.example` 必须能支撑该依赖独立部署——按它填完即可直接
   `docker compose up -d`（sandbox 系列是典型：`RCS_URL` / `RCS_SECRET` / `RCS_MACHINE_ID` 三项独立部署时全部必填）。
   两条口径由 `scripts/__tests__/component-compose-self-contained.test.ts` 静态强制：
   - 编排里 `${VAR:?}` 与**无缺省值**的 `${VAR}` 键，在依赖目录的 `.env.example` 里必须是**有效赋值行**（`KEY=`）：
     只留注释行等于没提供，独立部署在 `config` 阶段就报缺变量——那行注释通常正是「以为主服务 env 会带过来」的痕迹，
     而独立部署没有主服务。
   - **生成物模板**（`.env.example`、`docker/main/.env.example`）键行一律是注释行、必填键由 `./docker/deploy.sh validate`
     汇总点名，因此上面这条只对手写模板的依赖目录成立。

示例（`docker/sandbox-peri/.env.example`，三段式）：

```bash
# ── 必需：缺失即启动失败 ──
# 主服务地址：随主服务启动时由脚本注入 ws://rcs:3000，独立部署时填主服务可达地址
RCS_URL=
# 注册用共享密钥：必须等于主服务侧的 REGISTRY_SECRET；同机时脚本自动派生
RCS_SECRET=
# 控制台预创建（或自动创建）的机器 ID
RCS_MACHINE_ID=

# ── 可调：有默认值，按部署形态修改 ──
TZ=Asia/Shanghai

# ── 默认项：通常不需要修改 ──
# （本目录当前没有此类键；超时、重试、内部路径等默认项放在这里）
```

## 9. `docker/deploy.sh`（一键入口）

| 命令 | 行为 |
| --- | --- |
| `./docker/deploy.sh init` | 初始化配置：把各 `.env.example` 落成 `.env`（已存在一律跳过、不覆盖），生成缺失的部署期身份键（见下），随后报告还缺哪些必填项 |
| `./docker/deploy.sh export <目标目录>` | 导出交付面：把受版本控制的 `docker/` 拷到该目录下（排除 `dev/`、`compose-explorer/`；不含本机 `.env` 与 `data/`；已存在文件一律不覆盖，内容不同只逐条列出）。生产不在仓库工作区里跑，理由与目标机后续步骤见 [`deployment.md`](./deployment.md) §2.4 |
| `./docker/deploy.sh validate` | 只跑启动前的必填项校验（与 `up` / `deploy` 同一套，可反复自检） |
| `./docker/deploy.sh up`（默认） | 启动前校验 → 起主服务项目（创建 `fenix-server`）→ 按开关逐个起依赖 → 汇总状态 |
| `./docker/deploy.sh deploy` | 发布顺序（§10）：校验 → 拉镜像 → DDL 迁移 → 数据迁移 → `up` |
| `./docker/deploy.sh down [--purge-data --yes]` | 逆序停（依赖 → 主服务）；主服务一律带 `--profile redis` 停，避免开关已关时 `redis` 残留；`--purge-data` 删除数据目录，只列清单、加 `--yes` 才真删 |
| `./docker/deploy.sh ps` / `./docker/deploy.sh logs [name]` | 状态与日志 |
| `./docker/deploy.sh config` | dry-run：打印将执行的完整命令（审计与排障）；必填项未填只告警、不拦 |

交付面守卫：脚本目录（`docker/`）落在 git 工作区内时，只放行 `export`——`init` / `validate` / `up` /
`deploy` / `config` 直接拒绝并提示先 `export` 到仓库外（理由见 [`deployment.md`](./deployment.md) §2.4），
`down` / `ps` / `logs` 只告警，免得应急停止被挡在门外。判定是 `git -C <脚本目录> rev-parse --show-toplevel`：
worktree / submodule 的 `.git` 是文件而非目录、脚本也可能落在仓库深处，所以问 git 而不是看外层有没有 `.git`；
部署机上通常没有 git，这条守卫自动放行。

脚本随 `docker/` 目录一起交付（不进镜像、不装到 PATH）：它需要与 `docker/` 下的依赖目录同级才能发现它们；
自定位（`BASH_SOURCE`），因此可在任意工作目录下用 `./docker/deploy.sh` 或绝对路径调用（交付面里是
`./deploy.sh`）。

配置文件解析：默认读**与脚本同目录**的 `docker/deploy.env`（`init` 生成的那个）；它不存在而同目录恰好只有一份
`*.env` 时就用那一份（并打印用了哪份）；多份则报错列出候选、要求 `--config` 指定。`--config` 显式指定后不再自动发现。

### 必填项校验（`init` / `validate` / `up` / `deploy` 共用）

- **真相来源是 compose 的 `${VAR:?说明}`**，脚本不另维护一份必填清单：扫主服务编排（`docker/main/docker-compose.yml`，
  基础服务 `postgres` / `redis` 内联其中，随它一并校验）与**已启用**依赖的 compose，逐项确认有值；
  `up` / `deploy` 在动任何容器前先跑这道闸。
- **模块声明键不在这个扫描面上**：`${VAR:?}` 只覆盖编排插值键，而模块 `envDefinitions` 声明的必填键由 rcs **启动期**
  校验（`apps/server/src/env-loader.ts`）——缺失的后果是容器起不来，而不是启动前被拦下。当前没有像这样的必填声明键。
- **`WORKFLOW_V2_PLATFORM_ACCOUNT_EMAIL` 的部署期生成保留**（2026-10-16 起它与另两枚能力键在声明侧都是可选，
  缺失不再阻塞启动）：脚本仍在 `init` / `up` / `deploy` 时补一道 **生成并固化**
  （`docker/lib/config.sh` 的 `ensure_workflow_platform_account_email`）——不是为了让进程能起来，而是让
  「启用画布」这条路上的账号身份**一次定下、不再需要人工填**：缺失时按主机名派生
  `workflow-v2-platform+<主机名>@example.com` 写进 `docker/main/.env`，**已有值一律不动**。它是**身份**而不是密钥
  （密钥可以随时重新生成，它一旦被上游用作账号就是该账号的所有权）：上游首次引导会用它自助注册，改值等于换上游
  账号——需要重新引导，并人工清理上游的旧账号（见 `docker/workflow/README.md` §5）。`validate` 与 `config`（干跑）
  只读，不生成。
- 为什么不用 `docker compose config` 代劳：它一次只报第一个缺失键，而首次部署需要一次看全；
  逐键解析还能把 compose 里写的说明原文回显给用户。
- 判定顺序与 Compose 一致：shell 环境（脚本已导出主服务 env 与 `deploy.env`）→ **该编排目录自己的** `.env`
  （主服务查 `docker/main/.env`，依赖查自己的目录）；空值按未填写处理（与 `${VAR:?}` 语义一致）。
- 失败输出「键 → 填在哪个文件 → compose 里写的说明」，并提示密钥可用 `openssl rand -hex 32` 生成。
- 例外只有 `RCS_URL` 与 `RCS_SECRET` 两个键：它们不由主服务 env 供给（`RCS_URL` 是节点侧的键，主服务进程不
  消费、也不在主服务 env 模板里；`RCS_SECRET` 的对应物在主服务侧叫 `REGISTRY_SECRET`）。
  脚本对声明了这两个键的依赖按「同机」注入 `ws://rcs:3000` 与 `REGISTRY_SECRET`，依赖自己的 `.env` 填了则以其为准
  （独立部署场景）。判定的取值顺序是「依赖 `.env` ＞ 已导出的 shell 环境 ＞ 注入值」。详见 §8 规则 3。

前置检查（失败即退出，并给出可操作提示）：

1. `docker` 与 `docker compose` 可用，Compose ≥ 2.20；
2. `docker/deploy.env` 可解析（默认同目录；缺省提示 `./docker/deploy.sh init`，同目录有多份配置时要求 `--config`）；
3. 主服务 env `docker/main/.env` 存在（缺省只告警，提示 `./docker/deploy.sh init`；必填键由上面的校验兜底）；
4. 主服务编排（`docker/main/docker-compose.yml`，含内联的基础服务）存在；
5. 未知 `FENIX_FEATURE_*` 报错。

顺序不变量：**任何依赖项目启动前主服务项目必须已启动**（`fenix-server` 由主服务项目创建，依赖以 `external: true` 引用）。

## 10. 发布与升级

发布顺序沿用[升级](./upgrade.md) §1（**DDL 迁移 → 数据迁移 → 新版本应用进程**），执行入口从 `bun run release --deploy`
改为 `./docker/deploy.sh deploy`：

1. `docker compose pull rcs` —— 拉取 `docker/main/` 编排 `image:` 行写死的目标版本（发布前先把该行改成新 tag 并提交，
   仓库根 dev 编排的同一行同步更新）；
2. DDL：`docker compose run --rm rcs bun migrate.js`（复用主服务项目的环境、网络与挂载定义）；
3. 数据：`docker compose run --rm rcs bun data-migration-runner.js`（**必须与应用相同的挂载**）。独立数据迁移入口是
   较新版本才随镜像发布的：更早的发布镜像没有该文件（数据迁移由应用启动时自行执行），`deploy.sh` 检测不到入口会
   跳过本步并打印说明——这是「新脚本 + 旧镜像」组合下的兼容路径，不是静默跳过；
4. `./docker/deploy.sh up` —— 声明式收敛到目标版本。

三条既有约束不变：迁移先于应用进程；数据迁移不写进容器启动命令（多副本会各跑一次含文件副作用的迁移）；
失败即停，输出「哪一步、为什么、能否重跑」。

镜像来源三种，与 `docs/operations/upgrade.md` 口径一致：

- GHCR 发布（`.github/workflows/docker-publish.yml`，main 与 `v*` tag）；
- 离线交付（`docker/build-image.sh` 产出 tar，目标机 `docker load`）；
- dev 本地构建（仓库根编排的 `build:` 段；`--build` 构建出的镜像占用同一个 tag，之后走生产入口时
  `deploy.sh` 会先 `pull` 覆盖回发布镜像）。

**升级与回滚都改同一行**：把 `docker/main/docker-compose.yml` 的 `rcs` `image:` 改成目标 tag（进版本控制、经评审合入；
仓库根 dev 编排的同一行同步更新）→ `./docker/deploy.sh export <目标目录>` 把交付面同步到目标机（已存在文件不覆盖，
diff 核对后手工替换）→ 在交付面的 `docker/` 里 `./deploy.sh deploy`。直接改目标机上的
这份文件也能跑，但它会让「本机实际版本」脱离仓库记录，只在应急回滚时使用，并要求事后把同一 tag 回写仓库；
核对本机实际版本用 `./docker/deploy.sh ps`（镜像 tag/digest 可见）。

依赖的升级独立于主服务：改对应目录的镜像 tag 后单独 `up -d` 即可；主服务重启不会顺带升级依赖。

## 11. 运行形态

### 11.1 本地开发

- 容器全栈（dev 形态）：先备好仓库根 `.env` 的**唯一必填项**——`cp .env.example .env` 并填 `RCS_API_KEYS`
  （`rcs` 里写的是 `${RCS_API_KEYS:?}`，无默认值；插值先于 profile 过滤，缺它连 `docker compose config`
  都过不去）。这一步做完后**组件零配置**，`docker compose up -d`（**裸命令**，用仓库根编排，
  最小集 `postgres` + `rcs`；数据落仓库根）。组件按需追加：
  ```bash
  docker compose --profile redis up -d                          # 缓存
  docker compose --profile litellm --profile ragflow up -d      # 模型网关 + 知识库
  docker compose --profile hindsight --profile agent-sites --profile opensandbox up -d
  docker compose --profile ragflow down                         # 停一组，不影响其他
  ```
  除 opensandbox 需 `cp docker/dev/sandbox.toml.example docker/dev/sandbox.toml`（它的 `host_ip`
  依赖机器与组网形态）外，各组件的默认值直接可用；要改就写**仓库根 `.env`** 的同名键。
  可覆盖键与默认值对照表见 `docker/dev/README.md`。
- 源码运行（保持现状）：
  ```bash
  docker compose up -d postgres     # 仅数据库
  bun install
  bun run db:migrate                # DDL 迁移
  bash restart-server.sh            # build:web → bun run dev
  ```

### 11.2 单机 prod

```bash
./docker/deploy.sh export /opt/fenix           # 在仓库里执行：产出交付面 /opt/fenix/docker
# 下面三条在交付面里执行（仓库里会被守卫拒绝，见 §9 与 部署 §2.4）
./deploy.sh init                               # 生成 deploy.env 与各 .env（已存在则跳过）
./deploy.sh validate                           # 按提示补齐必填项，直到这一步通过
./deploy.sh deploy
```

最小交付面（目标机**无需源码与 bun、无需 Dockerfile**）：

```text
docker/main/            # 主服务编排（无 build，内联 postgres / redis）+ 同目录 .env；运行期出现 data/、workflow/、workspaces/
docker/deploy.sh
docker/deploy.env
docker/<启用的依赖>/    # 各自带编排与实例，运行期在各自目录里出现 data/
```

**env 与数据都在交付面内**：主服务的 env 是 `docker/main/.env`（模板 `docker/main/.env.example`，`init` 落成），
各依赖的 env 在自己的目录；仓库根 `.env` 只服务 dev 形态，不随交付面走。

**运行期数据就在这份目录里**：`docker/main/data`、`docker/main/workflow`、`docker/main/workspaces`（主服务与它内联的
基础服务）与各依赖目录自带的 `docker/<name>/data/**`（如 `docker/litellm/data/postgres`、`docker/ragflow/data/{mysql,rustfs}`、
`docker/workflow/data/{mysql,rustfs}`），都是 bind 挂载。备份 = 打包这份目录（跳过容器与镜像）；搬迁 = 整目录拷走。
所以两者都要进 `.gitignore`（`data` / `workspaces/` / `docker/main/workflow/` / `logs` / `/workflow/` 已有规则），
别把数据提交进仓库。

### 11.3 执行节点独立部署（sandbox）

```bash
./docker/deploy.sh init            # 生成各目录 .env（也可在该目录内手工 cp .env.example .env）
docker network create fenix-server # 独立节点机器上先建网络（同机由主服务项目创建，这一步跳过）
cd docker/sandbox-peri
# 填 RCS_URL（主服务可达地址）/ RCS_SECRET（与主服务侧 REGISTRY_SECRET 同值）/ RCS_MACHINE_ID 三项
docker compose up -d
```

与「随主服务一键起」的差异有二：`RCS_URL` 跨机时填主服务可达地址（端口即 `FENIX_HTTP_PORT`，默认 3001），
同机时由 feature 开关随主服务启动、经 `fenix-server` 用 `ws://rcs:3000` 直连；`RCS_SECRET` 同机时由脚本从
`REGISTRY_SECRET` 派生，跨机时手填同值。独立机器上该网络不会被谁创建，所以要么先 `docker network create fenix-server`
（只为名字解析），要么在 `.env` 填宿主可达的 `RCS_URL` 并删掉 compose 的 `networks` 段换取彻底隔离。
`RCS_MACHINE_ID` 与 `RCS_DEFAULT_MACHINE_ID` 的对应关系、以及「替代本机节点」的语义不变
（见 `docs/operations/deployment.md` 与各 sandbox 目录 README）。

## 12. 退役与迁移

### 12.1 资产映射

| 旧资产 | 去向 |
| --- | --- |
| 根 `docker-compose.yml` | **已改造**为 dev 形态编排（内联 `postgres` / `redis`、`include` `docker/dev/` 组件、网络统一、固定项目名与镜像；`build:` 只服务 dev） |
| `docker/main/docker-compose.yml` | **2026-10-08 新增**：主服务**生产形态**编排——无 `build:`、只用发布镜像、数据自包含在 `docker/main/` 下；`docker/deploy.sh` 的操作对象 |
| `docker/prod/docker-compose.yml` | **已退役并删除**：主服务并入主服务编排，`agent-sites` 落 `docker/agent-sites/`，`postgres` 一度落 `docker/common/`，2026-10-16 起**内联在主服务编排里**（§5） |
| `docker/prod/docker-compose.{litellm,hindsight,ragflow}.yml` | **已退役并删除**；编排内容搬到 `docker/{litellm,hindsight,ragflow}/` |
| `docker/prod/docker-compose.opencode.yml` | **已退役并删除**；OpenCode 沙箱以 `docker/sandbox-opencode/` 保留（`docker/sandbox/` 已改名） |
| `docker/prod/.env.example` 等三份模板 | **已退役并删除**；环境变量模板收敛为根 `.env.example` + `docker/deploy.env.example` |
| `deploy/compose/base.yml` | **已退役并删除** → 主服务编排 |
| `deploy/compose/overlays/knowledge.yml` | **已退役并删除** → 由 `docker/gotenberg/` 承接（该目录后续并入 `docker/ragflow/`，见下行） |
| `docker/gotenberg/` | **已并入** `docker/ragflow/docker-compose.yml`（与 RAGFlow 同一 compose 项目、共用 `FENIX_FEATURE_RAGFLOW` 开关与同一份 `.env`；目录与开关 `FENIX_FEATURE_GOTENBERG` 已删除。理由：两者是 knowledge 文档链路上的一组依赖——先转 PDF、再解析） |
| `docker/workflow/` 的栈内 `mysql` | 2026-10-08 上移到 `docker/common/` 成为共享实例，**2026-10-16 随共享实例退役回到本目录自带**（服务名 `mysql`，只在项目默认网络；凭据 `WORKFLOW_MYSQL_*` 写在本目录 `.env`）；库 `opencoze` 与上游 schema 仍由本目录的 `mysql-init` 建（§5.1） |
| `docker/workflow/` 的栈内 `minio` 与它的 `mc` 初始化 | **已删除** → 两个桶 `opencoze` / `milvus` 进本目录自带的 `rustfs`；建桶与图标播种由一次性的 `s3-init` 承担（原逻辑写在 minio 容器的 entrypoint 里） |
| `docker/ragflow/` 的栈内 `mysql` / `minio` | **已删除，2026-10-16 回退为本栈自带实例**：库 `rag_flow` 与账号 `ragflow` 由 `ragflow-mysql` 镜像的 `MYSQL_DATABASE` / `MYSQL_USER` 在数据目录首次初始化时建好（`ragflow-mysql-init` 与 `docker/ragflow/init-mysql.sh` 已删除）；对象存储同样是本栈自带的 `ragflow-rustfs`（同一个 RustFS 镜像，只换实例归属，见 §5）。它**没有「本栈的固定桶」这个对象**——不设上游的 `MINIO_BUCKET`（旧的桶名键已删除、也没有替代键），桶按知识库 / 文件目录（`kb_id` / `parent_id`）在运行期由 RAGFlow 自建，`ragflow-s3-init` 只建探测桶做实例能力探测 |
| `docker/ragflow/` 的栈内 `redis`（Valkey） | **改名保留**为 `ragflow-redis`：只做保留名避让（`redis` 是主服务实例在 `fenix-server` 上的名字），实例始终是本栈自带的——主服务那个 `redis` 无鉴权、`maxmemory` / 淘汰策略是服务端属性（按消费方不可配）、RAGFlow 固定用 `db: 1`，三条证据见 `docker/ragflow/README.md`「自带 Valkey」 |
| `docker/litellm/` 的栈内 `litellm-postgres` | 一度删除、库 `litellm` 与角色 `litellm` 进共享 `postgres`（由 `litellm-db-init` 建）；**2026-10-16 回退为本栈自带实例**：库与角色由 postgres 镜像的 `POSTGRES_USER` / `POSTGRES_DB` 在数据目录初始化时建好，不需要一次性初始化服务；口令键 `LITELLM_DB_PASSWORD` 写在本目录 `.env` |
| `deploy/manifests/`（modules.json / profiles / README） | **已退役并删除**（生成物） |
| `scripts/release.ts` + `lib/{deploy-artifacts,release-steps,module-dependency-facts}.ts` + `__tests__/release-generator.test.ts` | **已退役并删除** |
| 模块 `fenix.module.ts` 的 `dependencyServices` | **保留**：继续服务应用启动期校验与探活（`module-manifest.ts` / `host-startup.ts`）；退役的只是「由它生成部署产物」这条链路 |
| `deploy/assembly/*.json` | **保留**：应用装配 profile，与部署 feature 开关是两层开关（§13） |
| `deploy/env/rcs.example` | **已删除**（2026-10-08）：它是同一份声明面的第三份渲染且是子集（不含「声明面之外的键」），信息已被两份应用面模板覆盖；生成物收敛为 `.env.example`、`docker/main/.env.example` 与 `docker/deploy.env.example` 三份 |
| 网络 `fenix-ver-net` / `fenix-server` | 统一为 `fenix-server`（§3） |
| `docker/workflow/`、`docker/ragflow/` 等现有依赖目录 | 保留；已补齐 §6 契约（网络接入清单、端口、README）。三个曾消费共享实例的目录（`workflow` / `ragflow` / `litellm`）**2026-10-16 起恢复自足**：自己的库与桶由各自目录内的实例提供，不依赖主服务项目先起；建库 / 建桶的编排留在各自的一次性初始化服务里（`docker/ragflow/` 的桶是例外——运行期由 RAGFlow 自建，见 §5、§5.1、§6） |
| `docker/sandbox/` | **已改名**为 `docker/sandbox-opencode/`（与 `sandbox-{peri,dsh,ccb}` 同族） |

已经落地、可直接使用的部分：

| 新资产 | 状态 |
| --- | --- |
| 根 `docker-compose.yml`（dev）/ `docker/main/docker-compose.yml`（生产） | 2026-10-08 拆分为两份：dev 带 `build:`（本地构建，数据落仓库根）、生产只用发布镜像且数据自包含在 `docker/main/` 下；两份都**就地内联** `postgres` / `redis`（`docker/main/` 不 `include` 任何文件，dev 根文件只 `include` `docker/dev/` 组件）、`name: fenix`、`fenix-server`、固定镜像；`docker compose config` 通过 |
| `docker/common/` | **2026-10-16 整体删除**（含 `docker/common/data/`）：`postgres` / `redis` 内联进主服务编排、数据落 `docker/main/data/`，`mysql` / `rustfs` 回到各依赖目录自带实例；`FENIX_FEATURE_MYSQL` / `FENIX_FEATURE_S3` 与「共享实例」概念一并退场（§5） |
| 共享实例的消费方（2026-10-08 收敛批次，2026-10-16 撤销） | `docker/{litellm,ragflow,workflow}/` 曾把各自的库 / 桶改为共享实例 + 一次性初始化服务（`litellm-db-init`、`ragflow-mysql-init` / `ragflow-s3-init`、`mysql-init` / `s3-init`），并实测确认「跨项目 `depends_on` 不成立」与「初始化失败不静默」两条口径（§6）。退役后：库 / 桶回到各目录自带实例，跨项目等待随之消失（`depends_on` 在本项目内即可表达）；`litellm-db-init` 与 `ragflow-mysql-init` 已删除（建库建角色交给镜像的初始化），保留的三个一次性初始化服务是 `docker/workflow/` 的 `mysql-init` / `s3-init` 与 `docker/ragflow/` 的 `ragflow-s3-init`。**2026-10-14 更新**：workflow 侧为「初始化资产随 server 镜像交付 + 单份 `.env`」，不再依赖上游 `WORKFLOW_STUDIO_DIR/docker/.env`，入口收敛为一条 `up -d`（§13.21） |
| `docker/deploy.sh`、`docker/deploy.env.example` | 已建；`init` / `validate` / 必填项拦截 / 未知开关报错 / 干跑均已在真实环境验证 |
| `docker/agent-sites/` | 已建（含 README 与三段式 `.env.example`），是后续依赖目录的样板；`docker/gotenberg/` 曾以同样形态存在，已按上表并入 `docker/ragflow/` |
| `docker/sandbox-{peri,dsh,ccb,opencode}/` | `RCS_URL` / `RCS_SECRET` / `RCS_MACHINE_ID` 走 `.env.example`（同机启动由脚本注入 `RCS_URL`，独立部署填真实地址）；辅助服务一律留在项目网络，只有执行节点接入 `fenix-server`。**2026-10-08 起 peri / ccb / opencode 的 compose 只引用发布镜像**（`ghcr.io/huangpustar/fenixagent-sandbox-<name>:v0.7.0-beta.1-<name>`，与主服务同版本；本地自建见各目录 README）；`dsh` 是唯一例外——GHCR 上没有它的发布镜像，仍从源码构建（§13.15） |
| `docker/{ragflow,litellm,hindsight,npm-registry,workflow}/` | 已补齐契约：固定镜像版本、端口回环绑定、网络接入清单、README；ragflow / litellm / hindsight 新增三段式 `.env.example`（npm-registry 无插值键，故不设；workflow 有自己的 `.env.example`——2026-10-14 起它是该目录唯一一份配置面，见 §13.21） |
| `docker/peri-fuse/` | **2026-10-10 新增**：LLM 观测（Langfuse 兼容实现，单容器 + 内嵌 Turso/SQLite，无 ClickHouse / Redis / S3）。写入侧消费方是 **Agent 进程**（本地执行在 `rcs` 容器内、沙箱节点在各自容器内），按 `LANGFUSE_BASE_URL=http://peri-fuse:23332` 直连上报；读取侧由主服务（`@fenix/resource-trace` 的只读薄层 → `/web/.../traces*`）访问同一基址，故本目录必须留在 `fenix-server` 网络上（§6 规则 3 的成员判定因此从「执行节点」扩到「主服务也会读它」）。宿主端口默认只绑回环，`.env` 暴露 `PERIFUSE_BIND_ADDR` / `PERIFUSE_HOST_PORT` / `PERIFUSE_SALT`；**版本键 `PERIFUSE_VERSION`**（覆盖 compose 的缺省 tag，§6 规则 10 的登记例外） |
| `docker/opensandbox-{cluster,server,server-tunnel}/` | 已补齐契约：镜像固定为 `…/v0.2.0`（不再插值）、`opensandbox-server` 改名并补开关；**2026-10-08 起三者的 compose 都不声明 `build:`**，只引用发布 tag（本地自建命令见各目录 README，隧道目录不再需要在 server 侧打标） |

### 12.2 迁移阶段（每阶段独立可验证）

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| 1. 立新 ✅ | 建基础服务（当时的 `docker/common/`，2026-10-16 退役并入主服务编排，见 §12.1）；改造主服务编排（include 基础服务、image/build 双声明、`fenix-server` 网络、数据 bind 到 `./data`）；写 `docker/deploy.sh`（含 `init` / `validate`）与 `docker/deploy.env(.example)` | 已完成：`docker compose config`、`./docker/deploy.sh config`、`up -d` 实跑（四容器 healthy，数据落在基础服务数据目录——当时是 `docker/common/data/`，现为 `docker/main/data/`）、`init` 幂等、必填项拦截与未知开关报错逐项验证 |
| 2. 迁依赖 ✅ | 各依赖目录补齐契约（网络接入清单、端口、README、三段式 `.env.example`）：`sandbox-*`（含 `opencode` 改名）、`ragflow`、`litellm`、`hindsight`、`npm-registry`、`workflow`、`opensandbox-*`（server 改名并补开关） | 已完成：逐个 `docker compose -f docker/<name>/docker-compose.yml config` 通过；起停冒烟留待阶段 3 的整机全流程 |
| 3. 换入口（在办） | prod 从 `docker/prod/` 切到 `./docker/deploy.sh deploy`；网络名统一为 `fenix-server` | 已完成的两项：入口切换（`docker/prod/` 与旧发布面已删除，`deploy.sh deploy` 是唯一 prod 入口）与网络名统一（§3）。仍待复跑的：整机 prod 全流程（迁移 → 启动 → 健康自检）——2026-10-08 的共享化改造曾把「依赖就绪」从隐式顺序变成显式判据，需要一次端到端复跑；2026-10-16 共享实例退役后判据回到各依赖目录内部（保留三个一次性初始化服务，见 §12.1），复跑口径不变（当前只跑到「启动 → down」，见文首状态） |
| 4. 退役 ✅ | 删除 `docker/prod/`、`deploy/compose/`、`deploy/manifests/` 与 release 链路；同步文档与代码引用 | 删除与文档/代码引用已同步；`bun run docs:build` 通过、`bun run precheck` 除 `package-tests` 中依赖本地已建库的一组用例外通过（见文首状态） |

阶段 2 的验收顺序：先做 `docker/sandbox-*`（有独立部署诉求、契约最完整），再做第三方栈（ragflow / workflow / litellm / hindsight），
最后处理 `opensandbox-*`（管理面与隧道的关系需要单独核对）。阶段 2 收尾时结算的两项：`docker/opensandbox-cluster/`
的镜像插值 `${OPENSANDBOX_CLUSTER_IMAGE:-…:latest}` 已改为写死的 `…/v0.2.0`（§13.7）；`docker/opensandbox-server/`
已改名 `docker-compose.yml` 并补开关 `FENIX_FEATURE_OPENSANDBOX_SERVER`（§6 / §7）。

### 12.3 退役已同步的文件（核对清单）

- 文档：`docs/operations/{deployment,index,upgrade,backup-and-restore,troubleshooting}.md`、`README.md`、
  `docs/developer/system/backend-development.md`、`docs/developer/architecture/engineering-standards.md`、`docker/*/README.md`。
  `docs/arch/25-workflow-v2.md` 与 `docs/design/2026-09-29-workflow-v2-*.md` 里的 `deploy/manifests` 属历史记录，保留原样。
- 代码：`package.json` 的 `release` script（已删）、`biome.json` 的部署产物格式化排除项（已删）、
  `scripts/generate-env-example.ts` 与其测试（已改造）、`scripts/__tests__/app-entry-paths.test.ts`（断言已删）。
- 曾引用 `deploy/compose|deploy/manifests|docker/prod` 的脚本/包（已逐一出清）：
  `scripts/migrate.ts`、`scripts/lib/env-example-spec.ts`、`packages/platform/platform-sdk/src/assembly/module-manifest.ts`、
  各 `packages/resources/*/fenix.module.ts`、`packages/platform/platform-sdk/src/__tests__/dependency-services.test.ts`。
- 容器名：旧 prod 用固定 `container_name: fenix-ver` / `fenix-postgres-ver`；主服务不再设 `container_name`
  （名称由项目名 + 服务名生成），需要稳定名字的依赖目录统一 `fenix-<name>` 前缀。
- 发布链：`.github/workflows/docker-publish.yml`（推送 GHCR 的 tag 规则）与 `docker/build-image.sh`（离线 tar）
  需在「固定 tag 写进两份编排的 `image:` 行」后复核，确认 tag 命名与文档写法一致。
- 环境变量模板：`scripts/generate-env-example.ts` 从声明面同批产出根 `.env.example`、
  `docker/main/.env.example` 与 `docker/deploy.env.example`；主服务自带基础服务的凭据键（`POSTGRES_PASSWORD`）
  已补进两份应用面模板，各依赖自带实例的凭据（`LITELLM_DB_PASSWORD`、`RAGFLOW_*` / `WORKFLOW_*`）只在各目录自己的模板里。
  原先的独立清单 `deploy/env/rcs.example` 已删除（信息与两份模板重复）。

## 13. 边界与不变量

### 两层开关，不要混淆

| 层 | 载体 | 决定 | 缺失后果 |
| --- | --- | --- | --- |
| 应用装配 | `deploy/assembly/<profile>.json`（`RCS_ASSEMBLY_PROFILE_PATH`） | 启动期**哪些模块加载**（路由、Web 贡献、能力注册） | 选择未注册模块启动即报错 |
| 部署 feature | `docker/deploy.env` | 部署期**哪些依赖服务启动** | 只让对应能力降级，不阻断主服务（依赖服务均 `required: false`） |

两者通过能力名对齐（如 `knowledge` ↔ `FENIX_FEATURE_RAGFLOW`），但**不做自动映射**：
部署面由 `docker/` 目录与 `docker/deploy.env` 显式声明，不再从模块 manifest 派生（这是 §12.1 中退役项的边界）。
开关与依赖目录一一对应，**一个目录里的多个服务共用一个开关**（`docker/ragflow/` 的 `ragflow` 与 `gotenberg`
就是这种形态：它们共用 `FENIX_FEATURE_RAGFLOW`，模块侧则是两条独立声明、各自有探针）。

### 硬约束（评审与实施时逐条核对）

1. 主服务编排（`docker/main/` 与 dev 根文件）是主服务与基础服务（`postgres` / `redis`）的唯一归属，
   **这两个名字在 `fenix-server` 上是保留名**；`mysql` / `rustfs` 不再是保留名（见 §5.1 / §3 规则 7）。
   依赖目录可以有同名的服务，但一律**不得接入 `fenix-server`**（同名会造成解析歧义）——`docker/workflow/` 的
   `mysql` / `rustfs` 就是这种形态。要接入 `fenix-server` 的实例必须换名（`docker/litellm/` 的 `litellm-postgres`、
   `docker/ragflow/` 的 `ragflow-mysql` / `ragflow-rustfs`），并同时避开 `postgres` / `redis` 与后续可能出现的同名组件。
   dev 形态（仓库根文件）内联了 `postgres` / `redis`，它不是依赖目录、只是保留名的另一个合法归属（§4）。
2. 网络只有两层（§3）；共享网络名唯一 `fenix-server`；接入它的服务名必须全局唯一，辅助服务不得接入。
   dev 形态的组件子编排（`docker/dev/`）不受本条约束：它们不是依赖目录，与主服务同属一个项目，
   全部服务同处 `fenix-server`。
3. 依赖目录以独立项目启动，禁止与主服务 `-f` 叠加；依赖启动前主服务必须已启动（网络存在性由主服务保证）。
4. feature 开关与依赖目录一一对应；未知开关报错。
5. 发布顺序 DDL → 数据 → 应用，任何路径不得颠倒；数据迁移不写进容器启动命令。
6. 密钥只进 `.env`：不进 `docker/deploy.env`、不进 compose 文件、不进 git。
7. **版本与身份写死在文件里**：镜像 tag 写在各 compose 的 `image:` 行（含第三方依赖镜像，不得用 `latest`），
   项目名写死主服务编排的 `name:`；两者都不做环境变量插值，部署环境不参与版本与身份决策。
8. **数据一律 bind 挂载**：相对 compose 文件写成 `./data/...`，禁止命名卷与匿名卷——数据必须留在交付面内，
   能整体打包/搬迁/备份，并在 `ls` 里看得出归属。代价见 §14。唯一例外是 `docker/sandbox-peri/` 的工作区
   （多绑一条仓库根 `workspaces/`，见 §6.5 与 §14.17）。
   **另一处已批准的有意例外**：`docker/dev/docker-compose.opensandbox.yml` 的 `opensandbox-server` 把 DinD
   状态目录 `/var/lib/docker` 挂成命名卷 `fenix_opensandbox-server-dind-docker`。理由：DinD 内部状态（镜像 /
   容器 / 卷）不需要搬迁或备份，本就不是本条要保护的「用户数据」；而 macOS 上 bind 进去会让 dockerd 在
   overlay2 的 metacopy 检查处 chmod 只读文件系统而崩溃循环。移除条件：平台文件共享支持 dockerd 所需的
   chmod，或节点改为非 DinD 形态。理由与命令同在 `docker/dev/docker-compose.opensandbox.yml` 的 `volumes:` 节。
9. Compose ≥ 2.20；include 与独立启动文件的相对路径均相对其自身目录解析。
10. 每个依赖目录必须有 README（含网络接入清单）；新增依赖 = 新目录 + feature 对照表登记 + 契约自检（§6）。
11. env 按 §8 执行：三段式排序；每个键只属于一个所有者（§8 规则 3）；必需项一律 `${VAR:?}`；容器内地址不做同名插值；
    内联在主服务编排里的 `postgres` / `redis` 不设自己的 env 文件；dev 组件是例外形态（内联默认值、不设 env 文件，见 §8），
    且已移出部署面 env 发现。
12. 必填项的真相只在 compose 的 `${VAR:?}`（脚本不另存清单）；`up` / `deploy` 在动任何容器前先过这道校验；
    `init` 只创建缺失文件，**绝不覆盖**已有 `.env`（那里面可能已经是生产配置）。唯一需要脚本落值的是
    `WORKFLOW_V2_PLATFORM_ACCOUNT_EMAIL`——compose 里没有它，脚本在缺失时按主机名生成并固化（§9），
    这是为了免去人工填身份、不是为了满足启动校验（该键在声明侧是可选）；取值规则与 `init` 一致：
    **只补缺失、绝不覆盖**。
13. **需要建库 / 建账号 / 建桶的目录必须有一次性初始化服务**（库名、账号、schema 应用的创建都在那里，形态逐条见 §6）；
    启动顺序用**同项目内**的 `depends_on: service_healthy` / `service_completed_successfully` 表达——跨项目的 `depends_on`
    不成立，本体系也不再需要它（没有跨项目等待，§6）。
    **已知例外一处**（2026-10-12 登记）：`docker/git/` 的库与角色由运维按该目录 README 的显式步骤在启动前创建，
    不设一次性初始化服务（理由与代价见 §6）。
14. **上游未发布 arm64 变体的镜像必须写 `platform: linux/amd64`**：不写时 arm64 主机（Mac）拉取直接报
    `no matching manifest` 装不起来。核对方式 `docker buildx imagetools inspect <image>`；现状六处（4 个镜像）——
    `docker/agent-sites/` 的 `agent-sites`、`docker/ragflow/` 的 `ragflow` 与 `ragflow-s3-init`、
    `docker/workflow/` 的 `coze-server` / `coze-web` / `assets-init`（后两者与 server 同镜像，`assets-init` 也拉它）。
    **反例**：同目录的 `atlas-init` 用多架构的 `arigaio/atlas`，不加该行。上游补发 arm64 后删除对应行：它只是
    “该镜像只有 amd64”的兜底，不是把栈锁在 amd64；对多架构镜像一律不加（强制模拟会白丢 arm64 的原生性能）。

## 14. 审阅要点（本版给出的关键取舍）

1. **取代而非并存**：`docker/prod/` 与 `deploy/compose/` 整体退役；不存在“目标归属 vs 当前使用”的双轨期描述。
2. **`dependencyServices` 字段保留**（与「模块 manifest 只保留能力声明」的字面表述有出入）：它仍被应用启动期的
   校验与探活消费（`module-manifest.ts` / `host-startup.ts`），退役的是生成部署产物的链路。若要求彻底删字段，
   需同时移除应用侧消费，属独立变更。
3. **依赖目录用「独立项目」而非 `-f` 叠加**：规避多文件叠加时相对路径基准漂移的坑；代价是 `down` 需要脚本逆序遍历。
4. **配置文件用 `KEY=VALUE`（`docker/deploy.env`）而非 YAML/JSON**：目标机零解析依赖，与 Compose 插值同源；
   脚本刻意不用 `source` 读取，避免 `$` / 反引号被展开改写密钥。
5. **对象存储用 RustFS、不用 MinIO**：RustFS 是团队现网实现，两者协议与端口重合，并存只会让「用哪套」变成
   部署环境的隐性问题。仓库里有**两套 RustFS 实例**，各归各栈：`docker/workflow/` 的 `rustfs`（固定桶
   `opencoze` / `milvus`，由它的 `s3-init` 建，只在项目默认网络）与 `docker/ragflow/` 的 `ragflow-rustfs`
   （同一个 `rustfs/rustfs:1.0.1` 镜像、多桶布局，桶按 `kb_id` / `parent_id` 在运行期自建）——理由与边界见 §5。
   2026-10-08 那轮「收敛到共享 `rustfs`」已随 `docker/common/` 一起退役（2026-10-16）。仓库里因此只有一套 S3
   实现（RustFS），被拆开的只是实例的数量与归属。
6. **网络名统一为 `fenix-server`**（而非新造名字）：沿用 Workflow 已实践的出口接入模式，把两个历史名字收敛为一个。
7. **env 规范**（§8）：每个依赖目录自带 `.env.example`，文件内按「必需 → 可调 → 默认」三段排序；键按所有者在
   主服务 env 与各目录 `.env` 之间分工（§8 规则 3），「两侧必须同值」的键靠 `docker/deploy.sh` 把主服务 env
   导出为 shell 环境保持一致，于是「随主服务启动」与「独立部署」两条路径取值都一致。
8. **镜像固定版本写进文件、不经环境变量**（取代本文件早期版本的 `FENIX_RCS_IMAGE` 设计）：部署环境不参与版本
   决策，`git` 里看到的就是要跑的版本。代价是升级/回滚要在目标机更新这份 compose（或重新交付），见 §10。
9. **脚本放 `docker/` 内**（而非仓库根）：它靠同级目录发现依赖，放在一起才能整体交付；自定位使其可从任意目录调用。
10. **项目名写死 `name: fenix`**：容器名前缀与项目归属随之固定，不随交付目录名漂移。
11. **数据一律 bind 到 compose 同级的 `./data/`**（不用命名卷）：交付面自包含——`tar` 走一份目录就等于带走全部数据，
   备份/搬迁不需要额外的 `docker volume` 知识，也避免了「卷还在但没人知道它属于谁」。代价：数据绑在**那台机器的那份目录**上，
    多节点共享同一份数据或使用网络存储时不能照搬（Postgres 在 NFS 一类文件系统上会初始化失败），
    这种场景应改为显式的外部存储挂载并单独评审。
12. **`init` + 启动前必填项校验**：`init` 把各 `.env.example` 落成 `.env`（跳过已存在），校验读取 compose 的
    `${VAR:?}`（唯一真相，不另维护清单），失败时输出「键 → 填在哪个文件 → 说明」，`up` / `deploy` 硬拦、
    `config` 干跑只告警。代价是首次部署需要两步（init → 填 → validate/up），换来的是「不会带着半份配置启动」。
    模块声明键（当前只有 workflow 的平台账号邮箱）用同一套时机补值：脚本在缺失时生成并固化（§9）。
    代价是默认身份由脚本挑（主机名派生；要换成自控邮箱得重新引导并清理上游旧账号），
    换来的是「一个模块必填键不会让新部署起不来、也不会逼部署方预先决定未来才用到的账号」。
13. **`RCS_URL` / `RCS_SECRET` 由脚本按同机语义注入**：两者都不由主服务 env 供给——前者是节点侧的键（主服务进程不
    消费，也不在主服务 env 模板里），后者要与主服务的 `REGISTRY_SECRET` 同值；依赖自己的 `.env` 优先于注入
    （独立部署），注入只影响脚本启动的那条路径。
14. **env 模板是生成物、不是手写文件**：`scripts/generate-env-example.ts` 从代码里声明的环境变量
    （宿主 `apps/server/src/env.ts` + 各模块 `fenix.module.ts` 的 `envDefinitions`）与 `docker/` 目录扫描
    同批产出根 `.env.example`、`docker/main/.env.example` 与 `docker/deploy.env.example`；新增开关或键先改声明面
    再重跑脚本（`bun run scripts/generate-env-example.ts`），手改这三份会在下次生成时被覆盖。
    各依赖目录的 `.env.example` 是手写并随目录进版本控制（它们的键不来自宿主 env schema，脚本无从生成）。
15. **依赖目录只引用发布镜像、不声明 `build:`**（2026-10-08 起）：`docker/<name>/` 是交付单元，目标机没有源码与
    Dockerfile——镜像一律是 CI 发布物（固定 tag）或发布机器打好的同 tag tar（离线交付）；本地自建改走
    `docker build -f docker/<name>/Dockerfile …`（命令写在各目录 README，自建会占用发布 tag 的本地镜像，
    回到发布版本时用 `docker compose pull` 覆盖）。**例外只有 `docker/sandbox-dsh/`**：CI 的 matrix 里没有它，
    GHCR 上也没有它的发布镜像（`peri` / `ccb` / `opencode` 三个都有），补上发布链路后应改成 `image:`。
    `docker/opensandbox-server-tunnel/` 与 `docker/opensandbox-server/` 同镜像，只引用同一个 tag，不在隧道侧重复构建。
16. **sandbox 执行节点接入 `fenix-server`**：节点是主动出网的一方，但仍要按服务名连主服务（同机注入
    `ws://rcs:3000` 依赖该网络的 DNS），所以它们声明 `external: true` 接入。代价是同一网络里的 `postgres` /
    `redis` 对节点容器也可达；独立节点机器上需先 `docker network create fenix-server`，或改用宿主可达的
    `RCS_URL` 并去掉 `networks` 段以换取彻底隔离（见各目录 README 的「网络接入清单」）。
17. **`docker/sandbox-peri/` 的工作区多绑一条仓库根 `workspaces/`**（唯一违反「数据只落在本目录 `./data/`」的
    例外）：同机开发时让节点与平台看同一份文件，省去两处同步。代价是整目录交付到独立节点机器时该相对路径
    会落到交付位置之外的目录，所以它的 README 要求在那种场景改成绝对路径或 `./data/workspaces`。
    若要取消这个例外，删掉那一行并改绑 `./data/workspaces` 即可（不再与平台共享文件）。
18. **MySQL 的归属：`docker/workflow/` 自带实例**（2026-10-08 曾上移到 `docker/common/` 作共享基础设施，
    **2026-10-16 随共享实例退役回到本目录**）。当前形态与理由：
    - **实例只在项目默认网络**：`mysql` 与 `rustfs` 不接 `fenix-server`（因此可以与保留名同名而不冲突），
      平台侧只经 `coze-web` 一个出口接入。2026-10-08 那轮「共享实例的消费方必须接入 ②」带来的同名歧义与
      可达面代价，随实例回到本目录一并消失（§3 规则 7、`docker/workflow/README.md` §9）。
    - **只提供实例，不提供业务初始化**：建库建号与 schema 应用留在消费方自己的**一次性服务**（`mysql-init`）里，
      账号权限范围由该服务自己声明（当前是 `GRANT ALL ON <库>.*`）。
    - **凭据是本目录私有的**：`WORKFLOW_MYSQL_PASSWORD` / `WORKFLOW_MYSQL_ROOT_PASSWORD`（与 `WORKFLOW_S3_*` 一起）
      写在 `docker/workflow/.env`，不再从主服务 env 取（§8 规则 3）；`mysql-init` 等处的诊断文案与 README 同步于此。
    - **数据落点随交付面收进 `docker/workflow/data/{mysql,rustfs}`**。
    - **Elasticsearch 同样留在 workflow**：它一直在本目录，数据收进 `docker/workflow/data/elasticsearch`（§13.21）。
    - **上游资产不复制进本仓库**：`schema.sql` 与 Atlas HCL 仍从 `WORKFLOW_STUDIO_DIR` 挂载（只在 workflow 目录里引用）。
      **2026-10-14 superseded**：资产改随上游 server 镜像交付、由 `assets-init` 展开到 `docker/workflow/assets/`——
      本仓库仍然不落资产文件（这条不变），但也不再需要任何上游源码目录与 `WORKFLOW_STUDIO_DIR` 变量（§13.21）。
    - **数据搬迁两种口径**：生产按「停 → 拷 → 起 → 验收」拷目录，开发可「不迁、从零起」；旧目录在验收通过并
      跑过一个业务周期之前不删（可执行步骤见 `docker/workflow/README.md` §8）。
19. **开关不自动联动**：一个开关只负责它自己那个目录，不做目录之间的联动。
    理由：联动意味着在脚本里维护「哪个目录依赖哪个别的目录」的映射表，而这张表会随目录增删漂移。
    2026-10-16 起每个目录自带依赖实例，连需要联动的场景都不存在了（曾经的对偶问题是「忘了打开 `FENIX_FEATURE_MYSQL`
    导致消费方起不来」）。代价是首次部署要看一眼目标目录 README 的前置条件清单。
20. **共享实例阶段（2026-10-08 ~ 2026-10-16）：三个依赖栈把辅助服务收敛到 `docker/common/`**（LiteLLM → 共享
    `postgres`、RAGFlow → 共享 `mysql` + `rustfs`、Workflow → 共享 `rustfs`；当时的清单与消费方见 §5.1）。
    该形态已于 2026-10-16 整体退役，改回「每个组件自带依赖实例」（§5）。当时的取舍记录在此，供回溯：
    - **收益**：同一台机器上不再为每个栈各起一套关系库与对象存储（省资源、少几套备份对象），数据落点随交付面收进
      `docker/common/data/**`，地址与端口在容器内保持不变（服务名与端口沿用原值，上游配置不必改）。
    - **代价**：消费方容器必须进 ②，于是它与别的栈同处一张网（同名歧义、可达面变大）；共享实例的凭据是**全实例一对**
      （一个栈能读写另一个栈的库 / 桶）；栈内多出一次性初始化服务与一层启动顺序（§6）。
    - **现状边界**：每个目录的实例、凭据、消费方同处一个项目，键不跨目录读（§8 规则 3）；栈内的口令轮换、库空间占用
      与版本升级都不外溢到别的组件；初始化仍留在消费方自己的目录里（§5.1 第 1 条那一条原则不变）。
21. **`docker/workflow/` 收敛为一次启动的自包含交付面**（2026-10-14）。目标：干净机器上
    `./docker/deploy.sh up`（只打开 `FENIX_FEATURE_WORKFLOW`——本栈自带 MySQL / 对象存储 / ES 等实例）一次起全栈，
    不 clone 上游源码、不手工对齐两份 env、不在运行期联网装工具。四条改动与代价：
    - **初始化资产随 server 镜像交付**：上游 `backend/Dockerfile` 把 `docker/volumes` 与 `docker/atlas` 打进
      `/app/upstream-assets/docker/`（约 6MB / 144 文件，与二进制同 commit 同 tag）；本目录新增一次性服务
      `assets-init` 把它展开到 `docker/workflow/assets/`——docker 不能把镜像内路径直接挂进别的容器，消费方要的是宿主
      真实文件。**本仓库仍然不落任何资产文件**（§13.18 那条不变），变的是「从哪里取」。**过渡门槛**：
      `WORKFLOW_STUDIO_TAG` 早于该发布时 `assets-init` 明确报错退出、下游不启动（不静默起半截栈）；
      `sha-63fd6f8` 及之后带资产。`assets-init` 用 server 镜像而非新制品：不新增拉取面，代价只是运行期镜像 +6MB。
    - **Atlas 拆成 `atlas-init`（固定版本镜像）**：原先 `init-mysql.sh` 在运行期 `curl -sSf https://atlasgo.sh | sh`，
      是离线部署的最后一个出网点；现在用 `arigaio/atlas:1.3.3-community` 直接 apply（`--exclude` 集合与上游逐字一致）。
      它与 `mysql-init` 的边界是：`mysql-init` 落 `schema.sql` 并成功退出，`atlas-init` 再做差异收敛（顺序即 DSN 前提）。
    - **配置收敛为本目录唯一一份 `.env`**：上游单机形态的 `docker/.env` 不再挂载（镜像内 `/app/.env` 已带上游默认值，
      本目录 `.env` 只是它的叠加层）；`coze-server` 原有的两处挂载（上游 `.env` → `/app/.env`、`backend/conf` →
      `/app/resources/conf`）一并删除，后者本就在镜像里。**指向键**（`MYSQL_DSN` / `MINIO_*` / `REDIS_ADDR` / …）改由
      compose 的 `environment` 显式注入，值取自本目录 `.env` 的 `WORKFLOW_MYSQL_*` / `WORKFLOW_S3_*`，避免配置面漂移。
      **代价**：`init-mysql.sh` / `mysql-init` 等处的诊断文案与 README 的启动命令都必须跟着改，且改 `.env` 不再能改
      「连到哪里」（这是有意为之）。
    - **栈内数据收进交付面**：ES / redis / etcd / Milvus 从 `${WORKFLOW_STUDIO_DIR}/docker/data/` 迁到
      `docker/workflow/data/`；`WORKFLOW_STUDIO_DIR` 变量与上游源码 clone 一并退场（零引用，由目录契约测试守住）。
      **过渡代价**：存量部署要停机搬一次目录（`docker/workflow/README.md` §8.1），旧目录在验收通过前保留为回滚路径。
    - **为什么不新增独立 assets 制品**（备选方案，已否）：资产与镜像 tag 必须严格同 commit，独立制品会多一条版本对齐链；
      且 `coze-web` 的主 nginx 配置也不再挂载（镜像自带主配置，本目录只在站点配置里补回 `client_max_body_size`）。
