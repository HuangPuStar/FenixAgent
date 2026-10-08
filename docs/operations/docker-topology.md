# Docker 编排体系

> **本文是 FenixAgent Docker 编排实现（目录契约自检、组合机制细则、feature 开关键表、env 规范、启动脚本用法、交付面）的权威文档**；
> 部署结构、方式与拓扑见 [Docker 部署架构与拓扑](../arch/26-deployment-topology.md)。
> 旧体系（`docker/prod/README.md`、`deploy/compose/README.md`、`docs/operations/deployment.md` §2.2–2.4 的描述）
> 已按 §12 退役并删除，本文不再有并存期。
>
> **状态：阶段 1、2、4 已完成；阶段 3 已跑通「启动 → down」，整机 prod 的迁移/健康自检待复跑**。已建：顶层 `docker-compose.yml`（include + `name: fenix`
> + `fenix-server` + 固定版本镜像）、`docker/common/`（postgres / redis / rustfs / mysql 四个基础服务，全部是共享实例）、
> `docker/deploy.sh` + `docker/lib/config.sh`
> （含 `init` 与启动前必填项校验）、`docker/deploy.env.example`；`docker/` 下各依赖目录（含 `sandbox-opencode/`、
> `opensandbox-{cluster,server,server-tunnel}/`）均已补齐 §6 契约。
> 已验证：`bun run docs:build` 通过；`bun run precheck` 除 `package-tests` 中依赖**本地已建库**的一组用例
> （`workflow-v2` org-app，要求本地 Postgres 已迁移到 HEAD；本机库当时落后 13 个迁移）外全部通过——属环境状态，
> 与编排改动无关。
>
> **2026-10-08 变更：共享实例成形**。MySQL 从 `docker/workflow/` 上移到 `docker/common/`（开关 `FENIX_FEATURE_MYSQL`），
> 随后三个依赖栈把各自的辅助服务收敛到 common：LiteLLM 的库进共享 `postgres`、RAGFlow 的库与对象存储进共享
> `mysql` / `rustfs`、Workflow 的对象存储进共享 `rustfs`（`gotenberg` 另并入 `docker/ragflow/`）。这四个目录因此
> 都不再自足：它们依赖顶层项目先起，自己的库 / 桶由自己的**一次性初始化服务**负责（`litellm-db-init`、
> `ragflow-mysql-init` + `ragflow-s3-init`、`mysql-init` + `s3-init`，约定见 §6，操作面见各目录 README）。
> 其中 RAGFlow 侧**没有可预建的桶**：多桶模式下桶名由知识库 / 文件目录决定（运行期 UUID），由 RAGFlow 自建，
> 它的 `ragflow-s3-init` 退化为实例能力探测（§5、§5.1）。
> **同日追加：RAGFlow 的对象存储回退为「本栈自带实例」**（`ragflow-rustfs`，对 §13 规则 1 的例外）——共享实例上
> 它的隔离边界建不起来（桶名运行期 UUID + 全实例一对凭据 + 实例侧没有按消费方的桶策略），详见 §5；
> 它的库仍在共享 `mysql` 上，收敛没有全撤。
> 没有跟着收敛的是**缓存**与 workflow 的 Elasticsearch，理由与代价见 §5.1。

## 1. 设计结论速览

| 决策 | 结论 |
| --- | --- |
| 编排归属 | 顶层 `docker-compose.yml`（仓库根）是主服务与基础服务的唯一编排；`docker/<name>/` 是依赖目录，一个目录一个依赖 |
| dev / prod 共处 | 同一份顶层文件：dev 走 `build:`，prod 直接使用 `image:` 的固定版本，差异只由配置表达 |
| 镜像 | 固定版本、写在 compose 文件里，不用环境变量插值；发布时更新顶层 `rcs` 的 `image` 行（§4.2） |
| 网络 | 两层：依赖各自的**项目内网络** + 唯一的**主服务网络 `fenix-server`**（只让必要服务接入，§3） |
| 基础服务 | `docker/common/`：PostgreSQL（必需）+ RustFS（S3 兼容，不用 MinIO）+ Redis + MySQL；后三者由开关控制，四者都是**共享实例**（消费方与保留名见 §5.1） |
| feature 开关 | 配置文件 `docker/deploy.env` 驱动；一个开关对应一个依赖目录（即“sub 插件 docker”） |
| 一键启动 | `./docker/deploy.sh up`：任意机器，只需要 docker + bash + 一份配置 |
| env 规范 | 每个依赖目录自带 `.env.example`，文件内按「必需 → 可调 → 默认」三段排序；共享键只在根 `.env`（§8） |
| sandbox 执行节点 | 两者都支持：可随主服务一键起（feature 开关），也可按机器独立部署 |
| 旧体系 | `deploy/compose/`、`deploy/manifests/`、`scripts/release.ts` 的部署面生成、`docker/prod/` 全部退役（§12） |

## 2. 目标形态

```text
任意机器（只需 docker + compose ≥ 2.20 + bash）
  │
  ├─ docker/deploy.env ─ feature 开关与部署参数（部署方维护，一份配置描述一台机器）
  ├─ .env ───────────── 应用配置与密钥（不进版本控制）
  │
  └─ ./docker/deploy.sh up
       ├─ 顶层项目：docker compose -f docker-compose.yml [--profile …] up -d
       │    ├─ rcs                    主服务（dev: build / prod: 顶层 image 行的固定版本）
       │    ├─ include docker/common/  postgres（必需）、rustfs / redis / mysql（开关控制）
       │    └─ 网络 fenix-server       主服务层，唯一共享网络（§3）
       └─ 对每个启用的依赖：
            docker compose -f docker/<name>/docker-compose.yml up -d
            （独立项目；仅必要服务与共享基础设施的消费方接入 fenix-server）

仓库根
├── docker-compose.yml          # 顶层项目（dev / prod 共用）
├── .env / .env.example         # 应用配置与密钥
├── data/ workflow/ workspaces/ # 运行期数据（bind 挂载点，不进版本控制）
└── docker/
    ├── common/                 # 基础服务：pg / rustfs / redis / mysql；运行期数据在 common/data/
    ├── deploy.sh               # 一键入口
    ├── lib/config.sh           # 配置解析、必填项校验、依赖发现（被 deploy.sh source；交付面必须带上）
    ├── deploy.env / .example   # 部署配置（开关与参数，见 §7；.example 是生成物）
    ├── ragflow/  litellm/  hindsight/  npm-registry/  agent-sites/
    ├── workflow/               # Workflow V2 上游栈
    ├── sandbox-peri/  sandbox-dsh/  sandbox-ccb/  sandbox-opencode/   # 执行节点（引擎沙箱）
    └── opensandbox-cluster/  opensandbox-server/  opensandbox-server-tunnel/
```

数据落点一律「各自 compose 文件同级的 `./data/`」（§13.8）；每份配置描述一台机器，`docker/deploy.env` 就是那台机器的开关表。

三层职责：

| 层 | 内容 | 生命周期 |
| --- | --- | --- |
| 顶层项目 | 主服务 + 基础服务；裸 `docker compose up -d` 即最小可用集（rcs + postgres） | 与部署同生共死 |
| 依赖目录 | 可选能力的外部依赖（第三方栈或独立部署单元），即“sub 插件 docker” | 独立项目，可单独起停、单独升级 |
| 交付面 | `deploy.sh` + `deploy.env` + 上述文件 | 随版本发布 |

## 3. 网络分层

两层网络，职责不重叠：

| 层 | 网络 | 成员 | 可见性 |
| --- | --- | --- | --- |
| ① 项目内层 | 各 compose 项目的默认网络（Compose 自动创建，随项目名隔离） | 项目声明的全部服务 | 仅同项目内的服务互相可见 |
| ② 主服务层 | `fenix-server`（具名网络，顶层项目创建） | 主服务 `rcs`、common 的基础服务（含共享的 mysql）、各依赖中**需要与主服务互通或需要访问共享基础设施**的服务 | 网络内全部容器互相可见（跨项目） |

成员判定标准（唯一）：**这个服务是否需要与主服务（或需要访问主服务的执行节点）直接通信，或者是否需要访问 `docker/common/` 提供的共享基础设施。**

- 必须接入 ②：`rcs`；common 的全部基础服务（`postgres` / `redis` / `rustfs` / `mysql`——它们的服务名是跨项目 DNS 名）；
  依赖的对外出口服务——RAGFlow 的 API 服务与同栈的 `gotenberg`、`litellm`、`hindsight`、`npm-registry`、`agent-sites`、
  Workflow 的 `coze-web`（唯一出口）；**共享基础设施的消费方**（Workflow 的 `coze-server` / `milvus` 与它的一次性
  初始化服务 `mysql-init` / `s3-init`、RAGFlow 的初始化服务 `ragflow-mysql-init`、
  LiteLLM 的初始化服务 `litellm-db-init`）；
  sandbox 节点与 opensandbox 管理面。
- 不得接入 ②：依赖栈内部的辅助服务——数据库与缓存（RAGFlow 栈内改名后的 `ragflow-redis`、Workflow 的 `redis`）、
  对象存储（S3 实现，含 `docker/ragflow/` 自带的 `ragflow-rustfs` 与它同项目的 `ragflow-s3-init`）、
  消息队列（NSQ 类）、搜索引擎（`elasticsearch`）、向量库（`infinity` / `milvus`）等；
  它们只在 ① 内被本项目的出口服务访问。
- **共享基础设施是「辅助服务不接入 ②」的例外**：它们要被多个项目按名访问，只能放在 ② 上（容器内没有别的寻址方式：
  宿主回环端口在容器里不可达，`host.docker.internal` 还得每个消费方单独加 `extra_hosts`）。代价有两条，都必须接受：
  ① 消费方容器随之暴露在 ② 里（它对网络上的每个服务可见）；② 消费方同时挂在两个网络上，**同名服务会造成 DNS 歧义**（见规则 7）。
- 共享基础设施**不带任何栈的业务初始化**：common 只建实例与账号（`mysql` 的库 / 账号只在数据目录首次初始化时
  生效）。建库、建能预建的桶与 schema 迁移属于持有它们的那一方，由消费方自己的一次性服务承担（`mysql-init` /
  `s3-init`、`ragflow-mysql-init` / `ragflow-s3-init`、`litellm-db-init` 都是这种形态）——这样 common 无需引用任何
  依赖目录，顶层 include 在任何机器上都能解析。`docker/ragflow/` 是唯一不走共享实例的一次性服务组合：
  `ragflow-mysql-init` 仍跨项目（共享 `mysql`），`ragflow-s3-init` 同项目（自带 `ragflow-rustfs`，`service_healthy` 闸门），
  见 §5。

规则与理由：

1. ② 的成员是**最小必要集**。不让辅助服务进 ② 有三个直接收益：避免跨项目的服务名冲突（多个栈都有 `redis` / 对象存储）、
   收缩主服务的可达面（数据库与缓存不应被主服务或别的依赖直连）、依赖栈内部组件可自由替换（上游换实现不影响 ① 之外的任何人）。
   共享基础设施（common 提供的服务）与它的消费方是这条规则的**例外**，不是它被否定——共享的东西必须能被跨项目寻址（见上）。
2. **网络名唯一：`fenix-server`**。现状两个名字（`fenix-ver-net`、`fenix-server`）统一到后者——`docker/workflow/` 已按
   这套分层实践（只有出口 `coze-web` 显式接入共享网络，其余服务留在项目默认网络），本体系把它上升为所有依赖的通用契约。
3. 依赖项目里**只有显式声明 `networks` 的服务**进入 ②（以 `external: true` 引用）；未声明的服务自动留在 ①。
4. 接入 ② 的服务名是跨项目 DNS 名，必须**全局唯一**（契约见 §6）。
5. ② 由顶层项目定义并创建；依赖项目只引用，因此**依赖启动前顶层必须已启动**（顺序不变量，见 §9）。
6. 需要宿主直连的入口（调试端口、管理 UI）用端口发布表达，不通过网络表达。
7. **同名歧义**：一个容器同时挂在 ① 与 ② 上时，若两边都有同名服务，Docker 的容器 DNS 没有优先级约定（两个网络各自的
   记录都会被返回，取哪条取决于返回顺序）。所以：**共享基础设施的服务名（`postgres` / `redis` / `rustfs` / `mysql`）
   是全局保留名，任何依赖栈都不应再在自己的项目网络里使用它们**。现状：`docker/ragflow/` 的栈内 Valkey 与
   自带对象存储都已按此改名（`ragflow-redis`、`ragflow-rustfs`，后者换掉了随共享化删除的栈内 MinIO；`rustfs`
   这个名字只在共享实例那一处出现）；仍在用同名角色的只剩
   `docker/workflow/` 的 `redis`——它同时挂在两张网上，与共享 `redis` 同名，**只在两个开关同时打开时**才有歧义，
   判定命令与两种处理（同机不要同时启用 / 加唯一别名并同步该栈配置）见 `docker/workflow/README.md` §9
   （后者属独立变更，本次未做）。

## 4. 顶层项目（`docker-compose.yml`）

### 4.1 结构

```yaml
include:
  - path: docker/common/docker-compose.yml   # 相对本文件（仓库根）解析

name: fenix   # 固定项目名，不做插值：卷与容器都带项目名前缀，随目录名漂移等于换一套空数据

networks:
  fenix-server:
    name: fenix-server      # 主服务层网络（§3），唯一共享网络

services:
  rcs:
    image: ghcr.io/huangpustar/fenixagent:sha-f00efc9   # 固定版本；发布时更新本行
    build: { context: ., dockerfile: Dockerfile }       # dev 用 --build；prod 只用 image
    networks: [fenix-server]
    # …… 见 §4.3
```

- `include` 需要 Compose ≥ 2.20.0；被包含文件的相对路径**相对其自身目录**解析（Docker 官方语义），
  这是 `common/` 能独立成目录的前提；脚本启动前检查 Compose 版本。
- `name` 与 `image` 同属「写死在文件里、不做插值」的一类：交付面目录名、环境变量都不应改变数据身份。
- 同项目内 `depends_on: postgres: { condition: service_healthy }` 直接可用（common 的服务与 rcs 同属顶层项目）。
- include 是模型复制：命名冲突只告警、不合并 → common 的服务名（`postgres` / `redis` / `rustfs` / `mysql`）是**全局保留名**（§13）。
- 网络定义在顶层（网络属于主服务层）；common 文件内的服务引用同名网络，随顶层一起启动，不单独运行。
- common 里的共享服务**不得引用 `docker/<依赖>/` 下的任何文件**：顶层 include 的插值环境在没装依赖的机器上也要成立
  （裸 `docker compose -f docker-compose.yml config` 必须能跑通）。这条约束决定了「业务初始化归消费方」的形态（§5）。

### 4.2 dev / prod 共处机制

| 形态 | 命令 | 镜像来源 |
| --- | --- | --- |
| dev（容器） | `docker compose up -d --build` | 本地构建，tag 为顶层 `image` 行的值 |
| dev（源码） | `docker compose up -d postgres` + `bun run dev` | 只起基础服务 |
| prod | `./docker/deploy.sh deploy` | 顶层 `image` 行写死的固定版本（`pull` 拉取，不构建） |

- **镜像固定版本**：`image:` 一律写死 tag（包括第三方依赖镜像），不使用环境变量插值、不使用 `latest`；
  发布新版本 = 更新这一行（进版本控制、可审计、可回滚），部署环境不参与版本决策。
- prod 交付面不含 Dockerfile 与源码，镜像必须先 `pull`；顶层 `build:` 段只服务 dev。

### 4.3 主服务定义（保持既有语义）

- 启动命令 `bun migrate.js && exec bun --no-install run dist/index.js`：DDL 先于应用进程，多副本靠 `pg_advisory_lock` 串行。
- `environment` 显式给出容器内连接串（如 `DATABASE_URL: postgres://rcs:rcs@postgres:5432/rcs`）：
  `environment` 优先级高于 `env_file`，这样 `.env` 里为源码运行准备的 `localhost` 连接串不会污染容器内解析。
- 卷：**全部 bind 到本文件同级的 `./` 下**——`./data`（含 `./data/peri-home`，对应 Dockerfile 的 `VOLUME /root/.peri`）、
  `./workflow`、`./workspaces`。不声明任何命名卷：数据在交付面内，随目录整体搬迁/备份，不依赖 docker 全局卷。
- 健康检查 `GET /health`；日志 `LOG_FORMAT: json`；`env_file: .env`（`required: false`）。
- 端口 `"${FENIX_HTTP_PORT:-3001}:3000"`。

## 5. `docker/common/`（基础服务）

```yaml
services:
  postgres:       # 必需：DATABASE_URL 在宿主 schema 必填且无默认值（apps/server/src/env.ts），缺失即启动失败
  redis:          # profiles: ["redis"]          RCS_REDIS_URL；缺省时缓存回退进程内 Map、Y.Doc 快照不持久化
  rustfs:         # profiles: ["s3"]             S3 兼容对象存储（RustFS）；消费方 docker/workflow/
  mysql:          # profiles: ["mysql"]          共享关系库；消费方 docker/workflow/ 与 docker/ragflow/
```

- 四个服务都接入 `fenix-server`（§3）：主服务必需，且服务名是跨项目 DNS 名（全局保留名）。
- `redis` / `rustfs` 默认不发布宿主端口，仅网络内互通；`postgres` 的宿主端口由 `POSTGRES_PORT` 控制（本地源码开发需要，prod 可关）；
  `mysql` 的宿主端口由 `MYSQL_HOST_PORT`（默认 3306）控制，同样只绑回环、供宿主运维工具与排查用。
- 凭据（`POSTGRES_PASSWORD`、`RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY`、`MYSQL_ROOT_PASSWORD` / `MYSQL_DATABASE` /
  `MYSQL_USER` / `MYSQL_PASSWORD`）从根 `.env` 读取；默认值只服务本地，生产必须替换（`docker/workflow/README.md` 中复述）。
  端口类键属部署参数，与 `FENIX_HTTP_PORT` 一起放 `docker/deploy.env`。
- 数据一律 bind 到本文件同级的 `./data/`（四个子目录），**不用命名卷**：
  相对路径相对本文件解析，所以数据落在 `docker/common/data/` 下，随依赖目录一起交付/备份/搬迁；
  命名卷会落到 docker 全局目录（`/var/lib/docker/volumes/...`），打包交付面时容易漏、也看不出归属。
- common 随顶层项目启动（`include`），因此它的插值环境是**顶层的项目目录（仓库根/交付面）**：
  键取自根 `.env` 与脚本导出的环境，`docker/common/.env` 这种文件在本体系里不存在，也不要新增。
- 对象存储**只用 RustFS**（团队现网实现，S3 协议兼容），不引入 MinIO：两者都提供 9000/9001 端口与同名 SDK 协议，
  同时存在只会让「用哪套」变成部署环境的隐性问题。RustFS 服务端 9000、控制台 9001；健康检查用
  `curl -f http://localhost:9000/health`（本机已实测 200，`/health/ready`、`/health/live` 同样可用）。
- **对象存储的收敛只完成了一半**：`docker/workflow/` 原先自带的 MinIO 与写在它 entrypoint 里的 `mc` 初始化随本次收敛
  一起删除，出口服务直接指向共享 `rustfs`（容器内 `rustfs:9000`），建桶由它的一次性 `s3-init` 承担（形态与理由见 §6）。
  `docker/ragflow/` 的同类服务同样删除过，但**随后回退为本栈自带实例** `ragflow-rustfs`（见下一条）——
  收敛的目标是「对象存在哪只有一个答案」，代价是共享实例的凭据是全实例一对、各栈能读写彼此的桶；
  RAGFlow 在共享实例上无法建立有效的隔离边界，因此按用户裁定单独出去（§13 规则 1 的例外）。
- **`docker/ragflow/` 自带对象存储（例外，理由与边界要照抄）**：栈内服务 `ragflow-rustfs`（`rustfs/rustfs:1.0.1`，
  与共享实例同版本）只在 `ragflow-net`、不接 `fenix-server`、不发布宿主端口、服务名避开保留名 `rustfs`（命名
  `ragflow-rustfs`，与栈内 `ragflow-redis` 同一处置）。**为什么**：RAGFlow 用多桶模式，桶名是运行期 UUID
  （每个知识库 `kb_id` / 每个文件目录 `parent_id` 一个真实桶），而共享实例只有全实例一对凭据、实例侧也给不出
  「按消费方的桶策略」——两条合起来，在共享实例上它没有可用的隔离边界；隔离到自己的实例后，
  越权与跨栈桶命名空间两个问题同时消失。它的库仍在共享 `mysql` 上（由 `ragflow-mysql-init` 建），本条只针对对象存储。
- **两栈的「桶」形态不同，别照抄**：`docker/workflow/` 的桶是**固定名**（`opencoze` / `milvus`，由它的 `s3-init`
  创建并播种图标，在共享实例上）；`docker/ragflow/` **没有桶可预建**——它不设上游的 `MINIO_BUCKET`（编排里也不再有任何替代键），
  桶名由知识库 / 文件目录（`kb_id` / `parent_id`）决定，是运行期才出现的 UUID，由 RAGFlow 首次写入时自建，
  `ragflow-s3-init` 因此只做**实例能力探测**（建自己的探测桶 → 读写 → 删对象 → 只删自己建的桶）。
  **不要给它补回 `MINIO_BUCKET`**：那会把对象键变成 `<逻辑桶>/<对象名>`，既有对象全部读不到——多桶布局与既有
  存量数据一致（升级前的编排**从未**设过它），搬迁时键不用重打。

### 5.1 共享基础设施（`postgres` / `redis` / `rustfs` / `mysql`）

`docker/common/` 的四个服务都是**共享实例**：同一台机器上的多个栈共用一套，而不是每个栈各起一套。服务名
（`postgres` / `redis` / `rustfs` / `mysql`）是 `fenix-server` 上的跨项目 DNS 名，属**全局保留名**。

| 服务 | 开关 | 容器内地址（宿主端口） | 消费方 | 数据落点 |
| --- | --- | --- | --- | --- |
| `postgres` | 恒启动 | `postgres:5432`（`POSTGRES_PORT`，回环） | `rcs`（`DATABASE_URL`，库 `rcs`）；`docker/litellm/` 的库 `litellm` 与角色 `litellm`（由 `litellm-db-init` 建） | `docker/common/data/postgres` |
| `redis` | `FENIX_FEATURE_REDIS` | `redis:6379`（不发布宿主端口） | 只有 `rcs`（`RCS_REDIS_URL`）；两个依赖栈各自保留栈内实例（见下） | `docker/common/data/redis` |
| `rustfs` | `FENIX_FEATURE_S3` | `rustfs:9000`（S3 API）/ `9001`（控制台），默认不发布宿主端口 | 只有 `docker/workflow/`（桶 `opencoze`、`milvus`，由 `s3-init` 建）。`docker/ragflow/` **已改为自带实例**（`ragflow-rustfs`，只在它的项目网络里，见 §5），不消费本实例、也不受 `FENIX_FEATURE_S3` 影响 | `docker/common/data/rustfs` |
| `mysql` | `FENIX_FEATURE_MYSQL` | `mysql:3306`（`MYSQL_HOST_PORT`，回环） | `docker/workflow/`（库 `opencoze`，由 `mysql-init` 建）；`docker/ragflow/`（库 `rag_flow`、账号 `ragflow`，由 `ragflow-mysql-init` 建） | `docker/common/data/mysql` |

几个共同点：

- **口径：只提供实例，不提供业务初始化。** 初始化归持有 schema / 桶的那一方，由消费方自己的**一次性服务**承担
  （`litellm-db-init`、`ragflow-mysql-init`、`ragflow-s3-init`、`mysql-init` + `s3-init`，约定见 §6）。
  原因见 §4.1：common 不能引用任何依赖目录的文件（否则顶层 `config` 在没装依赖的机器上就失败），而库名 / 桶名与
  schema 属于各栈自己的交付面（`docker/ragflow/` 的桶名是例外中的例外：它在运行期由知识库 / 文件目录决定，
  不在交付面上，且该栈已自带实例，见 §5）。
- **消费方必须接入 ②**：共享实例只能在 `fenix-server` 上按名寻址，于是消费方的容器也随之暴露在该网络里
  （§3 规则 7 的同名歧义由此而来）。例外是 `rcs`：它与共享实例同属顶层项目，本就在 ② 上。
- **共享键只在仓库根 `.env` 定义**：`POSTGRES_PASSWORD`、`RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY`、
  `MYSQL_ROOT_PASSWORD` / `MYSQL_DATABASE` / `MYSQL_USER` / `MYSQL_PASSWORD`（§8）；消费方需要时由脚本导出或
  用 `${VAR:-…}` 引用，不在自己的 `.env` 里重复定义。

`mysql` 的上移（2026-10-08）与它带来的约束：

- **理由**：同一台机器上多个栈共用一套实例，比每个栈各起一套更省资源、也少一套备份对象；上游栈不再是它的唯一归属
  （RAGFlow 的知识库元数据随后也落到这里，库名 `rag_flow`）。
- **消费方不依赖实例的 `MYSQL_DATABASE` / `MYSQL_USER`**：那两个键只在实例的数据目录**首次初始化**时生效，
  对已经存在的实例（别的栈先起过）无效，靠它们会把「库和账号存在」寄托在别人的首启上。本文件里的
  `MYSQL_DATABASE` / `MYSQL_USER` / `MYSQL_PASSWORD` 因此只是**首次初始化时的便利项**：取值与 workflow 的默认值
  一致（`opencoze` / `coze`），换了值也不会改变已存在实例里的对象。
- **代价**：消费方同时挂在两个网络上（§3 规则 7）；`docker/workflow/` 的 `redis` 与共享 `redis` 在
  **两个开关同时打开**时同名，判定命令与两种处理写在 `docker/workflow/README.md` §9（本次未改）。
- **共享与业务的分界**：往共享实例里加**别的栈**的业务库 / 桶时必须走该栈自己的初始化服务，不要写进本文件——
  本文件一旦引用某个栈的路径，顶层 include 就不再是「任何机器都能解析」的。

**没有收敛的两处**（不要读成「已全部共享化」）：

- **缓存**：共享 `redis` 的消费方只有 `rcs`。`docker/ragflow/` 的栈内 Valkey **改名保留**为 `ragflow-redis`
  （保留名避让），不换共享实例的三条理由：共享实例**无鉴权**（RAGFlow 的模板渲染拿不到空口令，客户端会对着
  无口令实例 `AUTH`）、`maxmemory` 与淘汰策略是**服务端属性**（RAGFlow 要可淘汰缓存、RCS 的 Y.Doc 快照不许静默丢，
  两个消费方的最优策略互相冲突）、**键空间**上 RAGFlow 固定用 `db: 1`（且 `RCS_REDIS_CLUSTER` 形态下只有 db 0）。
  完整证据与重新评估条件见 `docker/ragflow/README.md`「共享 Redis（为什么不换）」。`docker/workflow/` 的栈内
  `redis` 未改名，代价同上。
- **Elasticsearch 仍在 `docker/workflow/`**：这是需求方的明确裁定（栈内服务的数据落点、健康检查与上游插件 / 索引
  模板都在该目录），**不是遗漏**——后续评审不要把它当成待办；共享保留名因此只有 `mysql` 一个新增来源。

## 6. 依赖目录契约（`docker/<name>/`）

每个依赖一个目录，必须满足：

1. `docker-compose.yml` 是唯一入口；目录自包含（不引用其他依赖目录的文件与卷）。
2. **不与顶层 `-f` 叠加**：脚本以「独立项目」方式启动（`-f docker/<name>/docker-compose.yml` 单文件），
   因此文件内的相对路径相对自身目录解析，语义稳定；跨文件叠加会让相对路径基准变成第一个 `-f` 文件的目录，
   这是本体系明确排除的用法。
3. **网络按 §3 分层**：需要与主服务互通、或需要访问共享实例（common 的 `postgres` / `redis` / `rustfs` / `mysql`）
   的服务接入 `fenix-server`（`external: true`），且服务名必须全局唯一；
   项目内部的辅助服务（数据库、缓存、对象存储、消息队列等）**不声明 `networks`**，留在项目默认网络。
4. 宿主端口只绑回环（`127.0.0.1:<port>:<port>`）或不发布；只有面向外部用户的入口（如 `agent-sites` 的站点端口）
   才能绑 `0.0.0.0`，且必须可用环境变量覆盖。
5. 数据一律 bind 到**本文件同级的 `./data/`**（相对路径相对自身 compose 文件解析）；禁止命名卷——
   数据必须能从交付面直接看到、打包、搬迁，`docker volume ls` 里那些看不出归属的卷正是要避免的形态。
   已知例外只有 `docker/sandbox-peri/` 的工作区：它多绑了一条 `../../workspaces`，为的是同机开发时
   让节点与平台看到同一份文件（理由与独立部署的注意事项见该目录 README 的「数据与挂载」）。
6. `README.md`：用途、前置条件、配置项、网络接入清单（哪些服务进 `fenix-server`）、验证命令、升级方式
   （`docker/workflow/README.md` 是完整范例）。**消费共享基础设施的目录还要写清：启动顺序（顶层先起）、
   共享实例不可用时的表现与判定命令、数据落点已不在本目录、以及与其他栈同名服务冲突时的处理。**
7. 幂等：重复 `up -d` 不破坏既有数据与状态。
8. 命名：项目名取目录名（`-f docker/ragflow/docker-compose.yml` → 项目 `ragflow`）；需要显式容器名时统一 `fenix-<name>`
   前缀（旧 prod 的 `fenix-ver` / `fenix-postgres-ver` 已随 `docker/prod/` 退役，顶层不设 `container_name`）。
9. **自带 env 文件**（规范见 §8）：`.env.example` 进版本控制、按三段式排序（必需 → 可调 → 默认）；
   独立部署时 `cp .env.example .env` 填完即可启动。

### 一次性初始化服务（消费共享实例的目录必备）

共享实例不带业务初始化（§5.1），所以「建本栈的库 / 账号 / 桶，必要时再应用 schema」必须由消费方自己在**栈内的
一次性服务**里做完。现有五例：`docker/workflow/` 的 `mysql-init`（`init-mysql.sh`）与 `s3-init`（`init-s3.sh`）、
`docker/ragflow/` 的 `ragflow-mysql-init`（`init-mysql.sh`）与 `ragflow-s3-init`（`init-s3.py`）、
`docker/litellm/` 的 `litellm-db-init`（`init-db.sh`）。其中两例形态特殊，评审时不要照抄成通例：
`docker/ragflow/` 的 `ragflow-s3-init`（多桶模式下它**没有可预建的桶**，只建自己的探测桶做实例能力探测、且目标是
**同项目自带实例**，等待靠 `service_healthy` 而不是跨项目重试，见 §5）与 `docker/ragflow/` 的自带实例本身
（它是「对象存储一律用共享实例」的例外，见 §5）。新增或改动这类服务时逐条核对：

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
5. **只挂它需要的那张网**：只访问共享实例的初始化服务只接 `fenix-server`，不接项目默认网络——接入面越小，
   跨项目 DNS 名越不容易撞车。
6. **启动顺序由它自己保证，不能靠 `depends_on`**：**跨项目的 `depends_on` 不成立**——Compose 只允许依赖本项目内
   已定义的服务名，写共享实例的服务名会直接报 `depends on undefined service …`（`litellm`、`ragflow`、`workflow`
   三处都实测确认过，加 `required: false` 也一样）。因此 shared 实例的就绪只能由**初始化服务自己等待**（带超时、
   按错误分支给出判定），再由**栈内的主服务依赖它的完成**：`depends_on: <init>: { condition: service_completed_successfully }`。
7. **失败不静默**：初始化服务非零退出 → 依赖它的栈内服务不启动（`docker compose ps` 里缺位或反复重启），
   `up -d` 的退出码本身不足以下结论——判定一律是「`docker ps -a` 里 `Exited (0)` + 日志末行的完成行」。

### feature 对照表

| 开关（`FENIX_FEATURE_<NAME>`） | 目录 | 平台能力 | 关键配置 |
| --- | --- | --- | --- |
| `RAGFLOW` | `docker/ragflow/` | knowledge 检索 + Office 转 PDF（gotenberg 服务并入本目录） | `RAGFLOW_API_URL` / `RAGFLOW_API_KEY` / `GOTENBERG_URL`；**依赖共享实例** `FENIX_FEATURE_MYSQL`；对象存储是**本栈自带**（`ragflow-rustfs`），不依赖 `FENIX_FEATURE_S3`（§5） |
| `LITELLM` | `docker/litellm/` | model-management：模型网关 | `RCS_MODEL_GATEWAY_*` |
| `HINDSIGHT` | `docker/hindsight/` | memory：长期记忆 | `HINDSIGHT_MCP_URL`、`DASHSCOPE_API_KEY` |
| `NPM_REGISTRY` | `docker/npm-registry/` | plugin-market：元数据源 | `PLUGIN_MARKET_REGISTRY_*` |
| `AGENT_SITES` | `docker/agent-sites/` | agent-config：站点部署 | `AGENT_SITES_MASTER_KEY` 等 |
| `WORKFLOW` | `docker/workflow/` | workflow-v2 | `WORKFLOW_STUDIO_DIR` 等，另有前置条件（见该目录 README）；**依赖共享实例** `FENIX_FEATURE_MYSQL` 与 `FENIX_FEATURE_S3`（§5.1） |
| `SANDBOX_PERI` / `SANDBOX_DSH` / `SANDBOX_CCB` / `SANDBOX_OPENCODE` | `docker/sandbox-*/` | sandbox 执行节点 | `RCS_URL` / `RCS_SECRET` / `RCS_MACHINE_ID` |
| `OPENSANDBOX_CLUSTER` | `docker/opensandbox-cluster/` | sandbox 管理面 | `FRP_PUBLIC_ADDRESS` / `FRP_TOKEN` / `CLUSTER_SERVICE_API_KEY` / `SERVER_API_KEY_ENCRYPTION_KEY` |
| `OPENSANDBOX_SERVER` | `docker/opensandbox-server/` | sandbox 执行面（DinD 服务端） | `OPENSANDBOX_SERVER_PORT` 等，无必需键 |
| `OPENSANDBOX_SERVER_TUNNEL` | `docker/opensandbox-server-tunnel/` | sandbox 执行面（frpc 隧道） | 无插值键（配置在 `frpc.toml`） |

`docker/opensandbox-server-tunnel/` 因目录自包含（§6.1）不声明 `build:`：它与 `opensandbox-server` 同镜像，
自建时先在 `opensandbox-server/` 构建并打同一 tag，再由本目录引用（见该目录 README）。

`docker/opensandbox-cluster/deploy/` 是**另一个部署单元**（独立沙盒机三合一编排），自带 `opensandbox` 网络、
不接 `fenix-server`，因此不参与本表的 feature 开关。

脚本不编排、也没有开关的目录（有意为之）：`docker/common/`（随顶层 include，`redis` / `s3` / `mysql` 走保留开关）。除此之外，**`docker/` 下每个带 `docker-compose.yml` 的目录都应有同名开关**。

保留开关与目录开关是同一套语义（都写进 `docker/deploy.env`、都映射到 `--profile`），区别只在「目录不存在」：
保留开关由 `docker/common/docker-compose.yml` 的 `profiles` 提供，脚本的 `COMMON_OPTIONAL_FEATURES` 与
`scripts/lib/env-example-spec.ts` 的 `COMMON_FEATURE_SWITCHES` 两处必须同时登记（生成器测试逐项比对）。
**开关之间不自动联动**：`FENIX_FEATURE_WORKFLOW=true` 不会替你把 `FENIX_FEATURE_MYSQL` 打开——
消费方缺共享服务时由它自己的就绪判据报错（`docker/workflow/README.md` §7 给出判定命令），而不是由脚本猜。

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

# ── common 的可选服务（随顶层项目启动，不对应目录）──
FENIX_FEATURE_REDIS=false
FENIX_FEATURE_S3=false             # 共享 rustfs：消费方只有 docker/workflow/（docker/ragflow/ 自带实例，不依赖它）
FENIX_FEATURE_MYSQL=false          # 共享 MySQL：消费方 docker/workflow/ 与 docker/ragflow/ 依赖它先起

# ── 部署参数：有默认值，按部署形态修改 ──
FENIX_HTTP_PORT=3001
POSTGRES_PORT=5432
MYSQL_HOST_PORT=3306          # 只绑回环
```

规则：

- 键名规则：目录名转大写、`-` 换 `_`（`sandbox-peri` → `FENIX_FEATURE_SANDBOX_PERI`）。
- **未知开关是错误**：脚本发现 `FENIX_FEATURE_*` 没有对应目录或保留名时直接报错退出，防止拼写错误静默失效。
- 默认全部关闭；`postgres` 恒启动，`S3` / `REDIS` / `MYSQL` 归 common 的可选服务。
  保留开关与目录开关一样只负责「起哪些服务」，**不做消费方与共享服务之间的自动联动**（理由见 §6 末）。
- **镜像键不在这里**：版本固定写在各 compose 的 `image:` 行（§4.2）；`docker/deploy.env` 里出现镜像键即视为设计漂移。
- 密钥**不进** `docker/deploy.env`（它进版本控制，模板为 `docker/deploy.env.example`）；密钥只进根 `.env`。
- `docker/deploy.env.example` 是**生成物**（`bun run scripts/generate-env-example.ts`，与 `.env.example`、
  `deploy/env/rcs.example` 同批产出）；开关清单以脚本发现的目录为准，模板只负责把清单落成文件，不手工维护。
  上面这份示例的开关名单与生成物一致（16 个：13 个目录开关 + `REDIS` / `S3` / `MYSQL`），核对方式：
  `grep -E '^# FENIX_FEATURE_[A-Z0-9_]+=' docker/deploy.env.example | sort` 与上面的名单逐行相同。
- **配置文件解析**（脚本行为，见 §9）：默认读与脚本同目录的 `docker/deploy.env`；它不存在而同目录恰好只有
  一份 `*.env` 时用那一份（部署方常按机器命名，如 `prod.env`）；有多份则报错列出、要求 `--config` 指定，不替你猜。
  所以「一份配置描述一台机器」= 把那份文件放进 `docker/`。

为什么是 `KEY=VALUE` 而不是 YAML / JSON：

- 目标机只保证 docker + bash，逐行 `KEY=VALUE` 解析即可读（脚本**刻意不用 `source`**：source 会展开值里的
  `$`、反引号，密钥可能被静默改写），零额外解析依赖；
- 与 Compose 的变量插值同源，脚本读到的值就是 compose 读到的值；
- 可注释、可 diff，能被 secret 管理系统按行替换。

## 8. env 文件规范

配置分四处，职责不重叠；**同一个键只在一处定义**，避免漂移：

| 位置 | 作用域 | 模板（进版本控制） | 运行时文件 |
| --- | --- | --- | --- |
| `docker/deploy.env` | 部署开关与部署参数（端口等，顶层） | `docker/deploy.env.example` | `docker/deploy.env` |
| 根 `.env` | 主服务（rcs）的应用配置与密钥 + **跨服务共享键**（含基础服务凭据 `POSTGRES_PASSWORD`、`MYSQL_*`） | `.env.example` | `.env` |
| `docker/<name>/.env` | 该依赖的私有键 | `docker/<name>/.env.example` | 同目录 `.env` |

`docker/common/`（基础服务）不设自己的 env 文件：它随顶层 `include` 启动，插值环境就是顶层的项目目录，
键只能来自根 `.env` 与 `docker/deploy.env`（见 §5）。共享键（`MYSQL_ROOT_PASSWORD` / `MYSQL_DATABASE` /
`MYSQL_USER` / `MYSQL_PASSWORD`）按同一条规则只定义在根 `.env`；**消费方（如 `docker/workflow/`）读的是上游
`docker/.env` 里的同名键，两处必须同值**——服务端的口令由 common 的容器写入数据目录，消费方那份只是用来拼 DSN。

规则：

1. **每个依赖目录自带一份 env 文件**：`.env.example` 随目录进版本控制，列出该依赖全部可配置键；部署方用
   `./docker/deploy.sh init` 一次性落成，或在该目录内 `cp .env.example .env`。所有 `.env` 一律被忽略——
   `.gitignore` 的 `.env` 规则匹配任意深度（已用 `git check-ignore` 实测 `docker/ragflow/.env`、`.env`），
   密钥永不进版本控制。`init` 只创建缺失的文件，已存在的一律跳过。
2. **文件内按必需性排序**（硬规范，评审时逐文件核对）：
   - **顶部：必需项**——无默认值，缺失即启动失败；compose 里一律写 `${VAR:?<缺失说明>}`，报错必须能回答
     「缺什么、去哪填」（空字符串同样触发报错，`:?` 把空值视为未设置）。
   - **中部：部署可调项**——有默认值，但按部署形态通常需要改（端口、镜像 tag、对外地址）。
   - **底部：默认项**——有安全默认值，通常不需要改（超时、重试、内部路径、调优参数）。
   - 三段用注释分隔；每个键上方一行注释：用途 + 必需性（必需／默认值）+ 缺失或改错的后果。
3. **共享键不重复定义**：跨服务共享的键（`POSTGRES_*`、`MYSQL_*`、共享服务的宿主端口等）只在根 `.env` 与
   `docker/deploy.env` 定义；依赖目录只写本依赖私有的键，需要共享键时 compose 用 `${VAR:?}` 引用，由顶层提供。
   - 上游栈的同名键（`docker/workflow/` 读的上游 `docker/.env` 里的 `MYSQL_*`）是**同一个服务端的另一份拷贝**：
     它不在本仓库、也无法由脚本注入，因此只能靠「两处同值」这条约定，部署与排障时按 §5.1 的说明核对。
   - **两个例外是 `RCS_URL` 与 `RCS_SECRET`**，它们要由主服务侧配置**派生**而不是从根 `.env` 同名键取：
     `RCS_URL` 在根 `.env` 里是主服务自用地址（源码运行指向本机 localhost），节点要的是「主服务可达地址」，
     同名不同义；`RCS_SECRET` 在主服务侧叫 `REGISTRY_SECRET`，注册是否通过由后者决定。
     因此脚本对声明这两个键的依赖按同机语义注入 `ws://rcs:3000` 与 `REGISTRY_SECRET`
     （依赖自己的 `.env` 填了则以它为准），独立部署时才在该依赖的 `.env` 里填真实地址与同值密钥。
     注入是脚本行为，所以同机与独立两条路径都能通过同一套 `${VAR:?}` 校验。
4. **容器内地址不做同名插值**：容器内的连接地址（如 rcs 的 `DATABASE_URL`）在 compose 里写显式值，不写成
   `${DATABASE_URL}`——根 `.env` 里为源码运行准备的 `localhost` 值一旦经 shell 环境进入插值，会把容器内地址
   污染成本机地址。
5. **加载与优先级**：
   - `docker compose -f docker/<name>/docker-compose.yml`（单文件）的项目目录 = 该文件所在目录，compose 自动
     读取同目录 `.env` 作插值——依赖目录的 env 天然生效且互不干扰。
   - `docker/deploy.sh` 启动时把根 `.env` 与 `docker/deploy.env` 导出为 shell 环境：**shell 环境优先于任何 `.env` 文件**，
     于是「随主服务启动」与「独立部署」两条路径下共享键的取值一致且可预期（依赖目录 `.env` 里的共享键在脚本
     路径下被顶层值覆盖，这正是不重复定义的原因）。
   - 注意：项目目录的 `.env` 只参与**变量插值**，不会自动注入容器；需要进入容器环境的键必须在 compose 里用
     `environment:` 或 `env_file:` 显式引用。
6. **独立部署自足**：依赖目录的 `.env.example` 必须能支撑该依赖独立部署——按它填完即可直接
   `docker compose up -d`（sandbox 系列是典型：`RCS_URL` / `RCS_SECRET` / `RCS_MACHINE_ID` 三项独立部署时全部必填）。

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
| `./docker/deploy.sh init` | 初始化配置：把各 `.env.example` 落成 `.env`（已存在一律跳过、不覆盖），随后报告还缺哪些必填项 |
| `./docker/deploy.sh validate` | 只跑启动前的必填项校验（与 `up` / `deploy` 同一套，可反复自检） |
| `./docker/deploy.sh up`（默认） | 启动前校验 → 起顶层（创建 `fenix-server`）→ 按开关逐个起依赖 → 汇总状态 |
| `./docker/deploy.sh deploy` | 发布顺序（§10）：校验 → 拉镜像 → DDL 迁移 → 数据迁移 → `up` |
| `./docker/deploy.sh down [--purge-data --yes]` | 逆序停（依赖 → 顶层）；顶层一律带全 profile 停，避免开关已关时 `redis` / `rustfs` 残留占着 `fenix-server`；`--purge-data` 删除数据目录，只列清单、加 `--yes` 才真删 |
| `./docker/deploy.sh ps` / `./docker/deploy.sh logs [name]` | 状态与日志 |
| `./docker/deploy.sh config` | dry-run：打印将执行的完整命令（审计与排障）；必填项未填只告警、不拦 |

脚本随 `docker/` 目录一起交付（不进镜像、不装到 PATH）：它需要与 `docker/` 下的依赖目录同级才能发现它们；
自定位（`BASH_SOURCE`），因此可在任意工作目录下用 `./docker/deploy.sh` 或绝对路径调用。

配置文件解析：默认读**与脚本同目录**的 `docker/deploy.env`（`init` 生成的那个）；它不存在而同目录恰好只有一份
`*.env` 时就用那一份（并打印用了哪份）；多份则报错列出候选、要求 `--config` 指定。`--config` 显式指定后不再自动发现。

### 必填项校验（`init` / `validate` / `up` / `deploy` 共用）

- **真相来源是 compose 的 `${VAR:?说明}`**，脚本不另维护一份必填清单：扫 `docker-compose.yml`、
  `docker/common/` 与**已启用**依赖的 compose，逐项确认有值；`up` / `deploy` 在动任何容器前先跑这道闸。
- 为什么不用 `docker compose config` 代劳：它一次只报第一个缺失键，而首次部署需要一次看全；
  逐键解析还能把 compose 里写的说明原文回显给用户。
- 判定顺序与 Compose 一致：shell 环境（脚本已导出根 `.env` 与 `deploy.env`）→ 该项目自己的 `.env`；
  空值按未填写处理（与 `${VAR:?}` 语义一致）。
- 失败输出「键 → 填在哪个文件 → compose 里写的说明」，并提示密钥可用 `openssl rand -hex 32` 生成。
- 例外只有 `RCS_URL` 与 `RCS_SECRET` 两个键：它们要由主服务侧配置**派生**，不能靠根 `.env` 的同名键传
  （`RCS_URL` 在根 `.env` 里是主服务自用地址，同名不同义；`RCS_SECRET` 的对应物在主服务侧叫 `REGISTRY_SECRET`）。
  脚本对声明了这两个键的依赖按「同机」注入 `ws://rcs:3000` 与 `REGISTRY_SECRET`，依赖自己的 `.env` 填了则以其为准
  （独立部署场景）。判定的取值顺序是「依赖 `.env` ＞ 已导出的 shell 环境（根 `.env`）＞ 注入值」。详见 §8 规则 3。

前置检查（失败即退出，并给出可操作提示）：

1. `docker` 与 `docker compose` 可用，Compose ≥ 2.20；
2. `docker/deploy.env` 可解析（默认同目录；缺省提示 `./docker/deploy.sh init`，同目录有多份配置时要求 `--config`）；
3. 根 `.env` 存在（缺省只告警，提示 `./docker/deploy.sh init`；必填键由上面的校验兜底）；
4. `docker-compose.yml` 与 `docker/common/docker-compose.yml` 存在；
5. 未知 `FENIX_FEATURE_*` 报错。

顺序不变量：**任何依赖项目启动前顶层必须已启动**（`fenix-server` 由顶层项目创建，依赖以 `external: true` 引用）。

## 10. 发布与升级

发布顺序沿用[升级](./upgrade.md) §1（**DDL 迁移 → 数据迁移 → 新版本应用进程**），执行入口从 `bun run release --deploy`
改为 `./docker/deploy.sh deploy`：

1. `docker compose pull rcs` —— 拉取顶层 `image:` 行写死的目标版本（发布前先把该行改成新 tag 并提交）；
2. DDL：`docker compose run --rm rcs bun migrate.js`（复用顶层项目的环境、网络与挂载定义）；
3. 数据：`docker compose run --rm rcs bun data-migration-runner.js`（镜像内已含该入口；**必须与应用相同的挂载**）；
4. `./docker/deploy.sh up` —— 声明式收敛到目标版本。

三条既有约束不变：迁移先于应用进程；数据迁移不写进容器启动命令（多副本会各跑一次含文件副作用的迁移）；
失败即停，输出「哪一步、为什么、能否重跑」。

镜像来源三种，与 `docs/operations/upgrade.md` 口径一致：

- GHCR 发布（`.github/workflows/docker-publish.yml`，main 与 `v*` tag）；
- 离线交付（`build-image.sh` 产出 tar，目标机 `docker load`）；
- dev 本地构建（顶层 `build:` 段）。

**升级与回滚都改同一行**：把顶层 `rcs` 的 `image:` 改成目标 tag（进版本控制、经评审合入）→ 把该文件交付到目标机 →
`./docker/deploy.sh deploy`。直接改目标机上的这份文件也能跑，但它会让「本机实际版本」脱离仓库记录，
只在应急回滚时使用，并要求事后把同一 tag 回写仓库；核对本机实际版本用 `./docker/deploy.sh ps`（镜像 tag/digest 可见）。

依赖的升级独立于主服务：改对应目录的镜像 tag 后单独 `up -d` 即可；主服务重启不会顺带升级依赖。

## 11. 运行形态

### 11.1 本地开发

- 容器全栈：`./docker/deploy.sh init`（生成配置）→ 按需开开关 → `docker compose up -d`（**裸命令**，最小集 rcs + postgres）。
- 源码运行（保持现状）：
  ```bash
  docker compose up -d postgres     # 仅数据库
  bun install
  bun run db:migrate                # DDL 迁移
  bash restart-server.sh            # build:web → bun run dev
  ```

### 11.2 单机 prod

```bash
./docker/deploy.sh init                        # 生成 docker/deploy.env 与各 .env（已存在则跳过）
./docker/deploy.sh validate                    # 按提示补齐必填项，直到这一步通过
./docker/deploy.sh deploy
```

最小交付面（目标机**无需源码与 bun**）：

```text
docker-compose.yml
docker/deploy.sh
docker/deploy.env
docker/common/          # 运行期出现 data/（postgres / redis / rustfs / mysql 的数据，bind 挂载）
docker/<启用的依赖>/
.env
```

**运行期数据就在这份目录里**：`./data`、`./workflow`、`./workspaces`（顶层）与 `docker/common/data/**`（基础服务），
都是 bind 挂载。备份 = 打包这份目录（跳过容器与镜像）；搬迁 = 整目录拷走。
所以两者都要进 `.gitignore`（`data` / `workspaces/` / `logs` / `/workflow/` 已有规则），别把数据提交进仓库。

### 11.3 执行节点独立部署（sandbox）

```bash
./docker/deploy.sh init            # 生成各目录 .env（也可在该目录内手工 cp .env.example .env）
docker network create fenix-server # 独立节点机器上先建网络（同机由顶层项目创建，这一步跳过）
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
| 根 `docker-compose.yml` | **已改造**为顶层（+ include common、网络统一、固定项目名与镜像） |
| `docker/prod/docker-compose.yml` | **已退役并删除**：主服务并入顶层，`agent-sites` 落 `docker/agent-sites/`，`postgres` 落 `docker/common/` |
| `docker/prod/docker-compose.{litellm,hindsight,ragflow}.yml` | **已退役并删除**；编排内容搬到 `docker/{litellm,hindsight,ragflow}/` |
| `docker/prod/docker-compose.opencode.yml` | **已退役并删除**；OpenCode 沙箱以 `docker/sandbox-opencode/` 保留（`docker/sandbox/` 已改名） |
| `docker/prod/.env.example` 等三份模板 | **已退役并删除**；环境变量模板收敛为根 `.env.example` + `docker/deploy.env.example` |
| `deploy/compose/base.yml` | **已退役并删除** → 顶层项目 |
| `deploy/compose/overlays/knowledge.yml` | **已退役并删除** → 由 `docker/gotenberg/` 承接（该目录后续并入 `docker/ragflow/`，见下行） |
| `docker/gotenberg/` | **已并入** `docker/ragflow/docker-compose.yml`（与 RAGFlow 同一 compose 项目、共用 `FENIX_FEATURE_RAGFLOW` 开关与同一份 `.env`；目录与开关 `FENIX_FEATURE_GOTENBERG` 已删除。理由：两者是 knowledge 文档链路上的一组依赖——先转 PDF、再解析） |
| `docker/workflow/` 的栈内 `mysql` | **已删除**（2026-10-08）→ 上移到 `docker/common/` 成为共享实例（开关 `FENIX_FEATURE_MYSQL`，§5.1）；库 `opencoze` 与上游 schema 由本目录的 `mysql-init` 建 |
| `docker/workflow/` 的栈内 `minio` 与它的 `mc` 初始化 | **已删除** → 两个桶 `opencoze` / `milvus` 进共享 `rustfs`；建桶与图标播种由一次性的 `s3-init` 承担（原逻辑写在 minio 容器的 entrypoint 里） |
| `docker/ragflow/` 的栈内 `mysql` / `minio` | **已删除** → 库 `rag_flow` 进共享 `mysql`（由 `ragflow-mysql-init` 建）；对象存储的栈内 `minio` 先被删、**同日回退为本栈自带实例** `ragflow-rustfs`（同一个 RustFS 镜像，只换实例归属，见 §5）。它**没有「本栈的固定桶」这个对象**——不设上游的 `MINIO_BUCKET`（旧的桶名键已删除、也没有替代键），桶按知识库 / 文件目录（`kb_id` / `parent_id`）在运行期由 RAGFlow 自建，`ragflow-s3-init` 只建探测桶做实例能力探测 |
| `docker/ragflow/` 的栈内 `redis`（Valkey） | **改名保留**为 `ragflow-redis`：只做保留名避让，不换共享实例——共享 `redis` 无鉴权、`maxmemory` / 淘汰策略是服务端属性（按消费方不可配）、RAGFlow 固定用 `db: 1`，三条证据见 `docker/ragflow/README.md`「共享 Redis（为什么不换）」 |
| `docker/litellm/` 的栈内 `litellm-postgres` | **已删除** → 库 `litellm` 与角色 `litellm` 进共享 `postgres`，由 `litellm-db-init` 建（口令键 `LITELLM_DB_PASSWORD` 仍在根 `.env`） |
| `deploy/manifests/`（modules.json / profiles / README） | **已退役并删除**（生成物） |
| `scripts/release.ts` + `lib/{deploy-artifacts,release-steps,module-dependency-facts}.ts` + `__tests__/release-generator.test.ts` | **已退役并删除** |
| 模块 `fenix.module.ts` 的 `dependencyServices` | **保留**：继续服务应用启动期校验与探活（`module-manifest.ts` / `host-startup.ts`）；退役的只是「由它生成部署产物」这条链路 |
| `deploy/assembly/*.json` | **保留**：应用装配 profile，与部署 feature 开关是两层开关（§13） |
| `deploy/env/rcs.example` | **保留**（环境变量清单的真相来源）；`generate-env-example.ts` 同时产出 `.env.example` 与 `docker/deploy.env.example` |
| 网络 `fenix-ver-net` / `fenix-server` | 统一为 `fenix-server`（§3） |
| `docker/workflow/`、`docker/ragflow/` 等现有依赖目录 | 保留；已补齐 §6 契约（网络接入清单、端口、README）。其中消费共享实例的三个目录（`workflow` / `ragflow` / `litellm`）**不再自足**：依赖顶层项目先起，自己的库与可预建的桶由各自的一次性初始化服务建（`docker/ragflow/` 的桶是例外——运行期由 RAGFlow 自建，见 §5；§5.1、§6） |
| `docker/sandbox/` | **已改名**为 `docker/sandbox-opencode/`（与 `sandbox-{peri,dsh,ccb}` 同族） |

已经落地、可直接使用的部分：

| 新资产 | 状态 |
| --- | --- |
| 顶层 `docker-compose.yml` | 已改造（include、`name: fenix`、`fenix-server`、固定镜像、`build:` 仅服务 dev）；`docker compose config` 通过 |
| `docker/common/` | 已建，四个服务都是共享实例（postgres 必需、redis / s3 / mysql 走 profile，消费方见 §5.1）；**已实跑**：`up -d` 后 `postgres` / `rcs` / `redis` / `rustfs` 四容器全部 healthy |
| 共享实例的消费方（2026-10-08 收敛批次） | `docker/{litellm,ragflow,workflow}/` 各自的库 / 桶已改为共享实例 + 一次性初始化服务（`litellm-db-init`、`ragflow-mysql-init` / `ragflow-s3-init`、`mysql-init` / `s3-init`）；**跨项目 `depends_on` 不成立**与「初始化失败不静默」两条口径在这三处各实测确认（§6）。解析验证：顶层（含 common）与 `docker/ragflow/` 的 `docker compose … config` 通过；`workflow` 与 `litellm` 的解析依赖各自环境里那份不进版本控制的文件（上游 `WORKFLOW_STUDIO_DIR/docker/.env`、本目录 `.env`），属部署环境状态，不是编排缺陷。**同日修正**：`docker/ragflow/` 的对象存储回退为自带实例（`ragflow-rustfs`，§5），库仍在共享 `mysql` |
| `docker/deploy.sh`、`docker/deploy.env.example` | 已建；`init` / `validate` / 必填项拦截 / 未知开关报错 / 干跑均已在真实环境验证 |
| `docker/agent-sites/` | 已建（含 README 与三段式 `.env.example`），是后续依赖目录的样板；`docker/gotenberg/` 曾以同样形态存在，已按上表并入 `docker/ragflow/` |
| `docker/sandbox-{peri,dsh,ccb,opencode}/` | `RCS_URL` / `RCS_SECRET` / `RCS_MACHINE_ID` 走 `.env.example`（同机启动由脚本注入 `RCS_URL`，独立部署填真实地址）；辅助服务一律留在项目网络，只有执行节点接入 `fenix-server` |
| `docker/{ragflow,litellm,hindsight,npm-registry,workflow}/` | 已补齐契约：固定镜像版本、端口回环绑定、网络接入清单、README；ragflow / litellm / hindsight 新增三段式 `.env.example`（npm-registry / workflow 无插值键，故不设） |
| `docker/opensandbox-{cluster,server,server-tunnel}/` | 已补齐契约：镜像固定为 `…/v0.2.0`（不再插值）、`opensandbox-server` 改名并补开关、tunnel 目录自包含不声明 build |

### 12.2 迁移阶段（每阶段独立可验证）

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| 1. 立新 ✅ | 建 `docker/common/`；改造顶层（include、image/build 双声明、`fenix-server` 网络、数据 bind 到 `./data`）；写 `docker/deploy.sh`（含 `init` / `validate`）与 `docker/deploy.env(.example)` | 已完成：`docker compose config`、`./docker/deploy.sh config`、`up -d` 实跑（四容器 healthy，数据落在 `docker/common/data/`）、`init` 幂等、必填项拦截与未知开关报错逐项验证 |
| 2. 迁依赖 ✅ | 各依赖目录补齐契约（网络接入清单、端口、README、三段式 `.env.example`）：`sandbox-*`（含 `opencode` 改名）、`ragflow`、`litellm`、`hindsight`、`npm-registry`、`workflow`、`opensandbox-*`（server 改名并补开关） | 已完成：逐个 `docker compose -f docker/<name>/docker-compose.yml config` 通过；起停冒烟留待阶段 3 的整机全流程 |
| 3. 换入口（在办） | prod 从 `docker/prod/` 切到 `./docker/deploy.sh deploy`；网络名统一为 `fenix-server` | 已完成的两项：入口切换（`docker/prod/` 与旧发布面已删除，`deploy.sh deploy` 是唯一 prod 入口）与网络名统一（§3）。仍待复跑的：整机 prod 全流程（迁移 → 启动 → 健康自检）——2026-10-08 的三次共享化改造新增了三个消费方与五个一次性初始化服务，把「依赖就绪」从隐式顺序变成显式判据，需要一次端到端复跑（当前只跑到「启动 → down」，见文首状态） |
| 4. 退役 ✅ | 删除 `docker/prod/`、`deploy/compose/`、`deploy/manifests/` 与 release 链路；同步文档与代码引用 | 删除与文档/代码引用已同步；`bun run docs:build` 通过、`bun run precheck` 除 `package-tests` 中依赖本地已建库的一组用例外通过（见文首状态） |

阶段 2 的验收顺序：先做 `docker/sandbox-*`（有独立部署诉求、契约最完整），再做第三方栈（ragflow / workflow / litellm / hindsight），
最后处理 `opensandbox-*`（管理面与隧道的关系需要单独核对）。阶段 2 收尾时结算的两项：`docker/opensandbox-cluster/`
的镜像插值 `${OPENSANDBOX_CLUSTER_IMAGE:-…:latest}` 已改为写死的 `…/v0.2.0`（§13.7）；`docker/opensandbox-server/`
已改名 `docker-compose.yml` 并补开关 `FENIX_FEATURE_OPENSANDBOX_SERVER`（§6 / §7）。

### 12.3 退役已同步的文件（核对清单）

- 文档：`docs/operations/{deployment,index,upgrade,backup-and-restore,troubleshooting}.md`、`README.md`、
  `docs/developer/guide/backend-development.md`、`docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md`、`docker/*/README.md`。
  `docs/arch/25-workflow-v2.md` 与 `docs/design/2026-09-29-workflow-v2-*.md` 里的 `deploy/manifests` 属历史记录，保留原样。
- 代码：`package.json` 的 `release` script（已删）、`biome.json` 的部署产物格式化排除项（已删）、
  `scripts/generate-env-example.ts` 与其测试（已改造）、`scripts/__tests__/app-entry-paths.test.ts`（断言已删）。
- 曾引用 `deploy/compose|deploy/manifests|docker/prod` 的脚本/包（已逐一出清）：
  `scripts/migrate.ts`、`scripts/lib/env-example-spec.ts`、`packages/platform/platform-sdk/src/assembly/module-manifest.ts`、
  各 `packages/resources/*/fenix.module.ts`、`packages/platform/platform-sdk/src/__tests__/dependency-services.test.ts`。
- 容器名：旧 prod 用固定 `container_name: fenix-ver` / `fenix-postgres-ver`；顶层不再设 `container_name`
  （名称由项目名 + 服务名生成），需要稳定名字的依赖目录统一 `fenix-<name>` 前缀。
- 发布链：`.github/workflows/docker-publish.yml`（推送 GHCR 的 tag 规则）与 `build-image.sh`（离线 tar）
  需在「固定 tag 写进顶层 `image:` 行」后复核，确认 tag 命名与文档写法一致。
- 环境变量模板：`deploy/env/rcs.example`（真相来源）与 `scripts/generate-env-example.ts` 已改为同批产出
  根 `.env.example` 与 `docker/deploy.env.example`；基础服务凭据键（`POSTGRES_PASSWORD`、`RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY`）
  已补进根 `.env.example`。

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

1. 顶层是主服务与基础服务的唯一归属；依赖目录不得再定义 `postgres` / `redis` / `rustfs` / `mysql`
   （四个都是共享实例的服务名 / 全局保留名，见 §5.1）。**已知例外一处**：`docker/ragflow/` 的 `ragflow-rustfs`
   （本栈自带对象存储，服务名刻意避开 `rustfs`、也不接 `fenix-server`）——用户裁定，理由与边界见 §5；
   加新的例外需要同样明确的裁定与理由，不要因为「它俩形态像」就照抄。
2. 网络只有两层（§3）；共享网络名唯一 `fenix-server`；接入它的服务名必须全局唯一，辅助服务不得接入。
3. 依赖目录以独立项目启动，禁止与顶层 `-f` 叠加；依赖启动前顶层必须已启动（网络存在性由顶层保证）。
4. feature 开关与依赖目录一一对应；未知开关报错。
5. 发布顺序 DDL → 数据 → 应用，任何路径不得颠倒；数据迁移不写进容器启动命令。
6. 密钥只进 `.env`：不进 `docker/deploy.env`、不进 compose 文件、不进 git。
7. **版本与身份写死在文件里**：镜像 tag 写在各 compose 的 `image:` 行（含第三方依赖镜像，不得用 `latest`），
   项目名写死顶层 `name:`；两者都不做环境变量插值，部署环境不参与版本与身份决策。
8. **数据一律 bind 挂载**：相对 compose 文件写成 `./data/...`，禁止命名卷与匿名卷——数据必须留在交付面内，
   能整体打包/搬迁/备份，并在 `ls` 里看得出归属。代价见 §14。唯一例外是 `docker/sandbox-peri/` 的工作区
   （多绑一条仓库根 `workspaces/`，见 §6.5 与 §14.17）。
9. Compose ≥ 2.20；include 与独立启动文件的相对路径均相对其自身目录解析。
10. 每个依赖目录必须有 README（含网络接入清单）；新增依赖 = 新目录 + feature 对照表登记 + 契约自检（§6）。
11. env 按 §8 执行：三段式排序；共享键只在根 `.env` 定义；必需项一律 `${VAR:?}`；容器内地址不做同名插值；
    `docker/common/` 不设自己的 env 文件。
12. 必填项的真相只在 compose 的 `${VAR:?}`（脚本不另存清单）；`up` / `deploy` 在动任何容器前先过这道校验；
    `init` 只创建缺失文件，**绝不覆盖**已有 `.env`（那里面可能已经是生产配置）。
13. **消费共享实例的目录必须有一次性初始化服务**（库 / 账号 / 桶的创建与 schema 应用都在那里，形态逐条见 §6）；
    启动顺序由它自己等待 + 栈内主服务 `depends_on: service_completed_successfully` 表达，不写跨项目 `depends_on`。

## 14. 审阅要点（本版给出的关键取舍）

1. **取代而非并存**：`docker/prod/` 与 `deploy/compose/` 整体退役；不存在“目标归属 vs 当前使用”的双轨期描述。
2. **`dependencyServices` 字段保留**（与「模块 manifest 只保留能力声明」的字面表述有出入）：它仍被应用启动期的
   校验与探活消费（`module-manifest.ts` / `host-startup.ts`），退役的是生成部署产物的链路。若要求彻底删字段，
   需同时移除应用侧消费，属独立变更。
3. **依赖目录用「独立项目」而非 `-f` 叠加**：规避多文件叠加时相对路径基准漂移的坑；代价是 `down` 需要脚本逆序遍历。
4. **配置文件用 `KEY=VALUE`（`docker/deploy.env`）而非 YAML/JSON**：目标机零解析依赖，与 Compose 插值同源；
   脚本刻意不用 `source` 读取，避免 `$` / 反引号被展开改写密钥。
5. **对象存储用 `rustfs`、不用 MinIO**：RustFS 是团队现网实现，两者协议与端口重合，并存只会让「用哪套」变成
   部署环境的隐性问题。共享实例（`docker/common/` 的 `rustfs`）现在的消费方是 `docker/workflow/`（固定桶
   `opencoze` / `milvus`，由它的 `s3-init` 建）；`docker/ragflow/` 在 2026-10-08 先随收敛删掉了栈内 MinIO，
   **同日又回退为自带实例** `ragflow-rustfs`（同一个 `rustfs/rustfs:1.0.1` 镜像、多桶布局不变）——理由与边界见 §5，
   它是「不用 MinIO」的遵守者、「用共享实例」的例外。仓库里因此仍只有一套 S3 实现（RustFS），
   被拆开的只是实例的数量与归属。
6. **网络名统一为 `fenix-server`**（而非新造名字）：沿用 Workflow 已实践的出口接入模式，把两个历史名字收敛为一个。
7. **env 规范**（§8）：每个依赖目录自带 `.env.example`，文件内按「必需 → 可调 → 默认」三段排序；共享键只在根
   `.env` 定义，由 `docker/deploy.sh` 导出为 shell 环境，保证「随主服务启动」与「独立部署」两条路径取值一致。
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
13. **`RCS_URL` / `RCS_SECRET` 由脚本按同机语义注入**：前者与根 `.env` 的同名键语义不同（自用地址 vs 可达地址），
    后者要与主服务的 `REGISTRY_SECRET` 同值——都不适合做成共享键；依赖自己的 `.env` 优先于注入（独立部署），
    注入只影响脚本启动的那条路径。
14. **三份 env 模板是生成物、不是手写文件**：`scripts/generate-env-example.ts` 从代码里声明的环境变量
    （宿主 `apps/server/src/env.ts` + 各模块 `fenix.module.ts` 的 `envDefinitions`）与 `docker/` 目录扫描
    同批产出 `deploy/env/rcs.example`、根 `.env.example`、`docker/deploy.env.example`；新增开关或键先改声明面
    再重跑脚本（`bun run scripts/generate-env-example.ts`），手改这三份会在下次生成时被覆盖。
    各依赖目录的 `.env.example` 是手写并随目录进版本控制（它们的键不来自宿主 env schema，脚本无从生成）。
15. **同一镜像的隧道目录不声明 `build:`**：`docker/opensandbox-server-tunnel/` 要能整目录拷到隧道机独立跑，
    所以它只引用镜像 tag（与 `opensandbox-server` 同源），自建时在 server 侧构建并打标，不在隧道侧重复构建。
16. **sandbox 执行节点接入 `fenix-server`**：节点是主动出网的一方，但仍要按服务名连主服务（同机注入
    `ws://rcs:3000` 依赖该网络的 DNS），所以它们声明 `external: true` 接入。代价是同一网络里的 `postgres` /
    `redis` 对节点容器也可达；独立节点机器上需先 `docker network create fenix-server`，或改用宿主可达的
    `RCS_URL` 并去掉 `networks` 段以换取彻底隔离（见各目录 README 的「网络接入清单」）。
17. **`docker/sandbox-peri/` 的工作区多绑一条仓库根 `workspaces/`**（唯一违反「数据只落在本目录 `./data/`」的
    例外）：同机开发时让节点与平台看同一份文件，省去两处同步。代价是整目录交付到独立节点机器时该相对路径
    会落到交付位置之外的目录，所以它的 README 要求在那种场景改成绝对路径或 `./data/workspaces`。
    若要取消这个例外，删掉那一行并改绑 `./data/workspaces` 即可（不再与平台共享文件）。
18. **MySQL 上移到 common 作为共享基础设施**（2026-10-08）：它从 `docker/workflow/` 的服务定义变成
    `docker/common/` 的可选服务（profile `mysql`，开关 `FENIX_FEATURE_MYSQL`），workflow 目录降级为消费方。
    取舍与代价写在这里，评审时按这几条核对：
    - **只提供实例，不提供业务初始化**：common 不能引用任何依赖目录的文件（否则顶层 `config` 在没装依赖的机器上
      就失败），所以「幂等建库建号 + schema 迁移」这类上游职责留在消费方，由它自己的**一次性服务**（`mysql-init`）承担。
      代价：消费方多一个服务、多一层启动顺序（顶层先起 → 初始化成功 → `coze-server` 启动）。账号权限范围由该服务自己声明
      （当前是 `GRANT ALL ON <库>.*`，与共享实例首次初始化时的授权范围一致）。
    - **消费方必须接入 ②**：共享实例只能在 ② 上按名寻址，于是 `coze-server` 也进了 ②，并因此拿到了与栈内
      `redis` 同名的解析歧义（§3 规则 7、`docker/workflow/README.md` §9）。这是本次变更最主要的安全与稳定性代价，
      换来的收益是「同一台机器多栈共用一套库」，以及数据落点随交付面收进 `docker/common/data/mysql`。
      范围只限 MySQL：Elasticsearch 仍留在 workflow，避免一次性改动面过大（它的插件与索引模板都依赖上游目录）。
      这条是**需求方裁定**，不是待办（§5.1 末）。
    - **上游资产不复制进本仓库**：`schema.sql` 与 Atlas HCL 仍从 `WORKFLOW_STUDIO_DIR` 挂载（只在 workflow 目录里引用）。
    - **数据搬迁两种口径**：生产按「停 → 拷 → 起 → 验收」拷目录，开发可「不迁、从零起」；旧目录在验收通过并
      跑过一个业务周期之前不删（可执行步骤见 `docker/workflow/README.md` §8）。
19. **开关不自动联动**：`FENIX_FEATURE_WORKFLOW=true` 不会顺带打开 `FENIX_FEATURE_MYSQL`。
    理由：联动意味着在脚本里维护「哪个目录依赖哪个共享服务」的映射表，而这张表会随目录增删漂移；让消费方在缺依赖时
    明确报错（就绪判据在消费方自己的初始化服务里，报错文本直接指出该打开哪个开关）比隐式联动更容易排查。
    代价是首次部署要看一眼消费方 README 的前置条件清单。
20. **共享实例成形：三个依赖栈把辅助服务收敛到 `docker/common/`**（2026-10-08，LiteLLM → 共享 `postgres`、
    RAGFlow → 共享 `mysql` + `rustfs`、Workflow → 共享 `rustfs`；清单与消费方见 §5.1）。取舍：
    - **收益**：同一台机器上不再为每个栈各起一套关系库与对象存储（省资源、少几套备份对象），数据落点随交付面收进
      `docker/common/data/**`，地址与端口在容器内保持不变（服务名与端口沿用原值，上游配置不必改）。
    - **代价**：消费方容器必须进 ②，于是它与别的栈同处一张网（同名歧义、可达面变大）；共享实例的凭据是**全实例一对**
      （一个栈能读写另一个栈的库 / 桶）；栈内多出一次性初始化服务与一层启动顺序（§6）。
    - **边界**：只收敛「实例」不收敛「初始化」（§5.1 第 1 条）；**缓存没有收敛**（`ragflow-redis` 改名保留、
      workflow 的 `redis` 未改名）、**Elasticsearch 留在 workflow**——这两处是评审时最容易被误读成遗漏的地方。
