# 公共 Git（common-git）运维说明

> 状态：实现基线（2026-10-12）。本文只写本版已落地的操作；未实现的脚本与流程逐条标注，不写成可执行步骤。
> 权威来源：模块行为以 [公共 Git 模块架构](../arch/28-common-git.md) 为准；编排契约与 feature 开关以 [Docker 编排体系](./docker-topology.md) 为准；Forgejo 目录自身的启动、初始化与升级以 `docker/git/README.md` 为准（本文不复述它的细节）。

## 1. 组件与两层开关

| 组件 | 落点 | 开关 |
|---|---|---|
| 公共 Git 模块（`@fenix/git`） | 主服务进程内的模块 | 应用装配：`deploy/assembly/ce-git.json` + `RCS_ASSEMBLY_PROFILE_PATH` |
| Forgejo（仓库与工单的事实源） | `docker/git/docker-compose.yml` 独立 Compose 项目、`docker/git/data/` | 部署 feature：`docker/deploy.env` 的 `FENIX_FEATURE_GIT`（默认 false） |
| 四张账本表 | 共享 `postgres` 里主服务自己的库 | 无开关：DDL 迁移与装配无关，任何 profile 都可执行 |

两层开关**互不自动映射**（[Docker 编排体系](./docker-topology.md) §13）：`FENIX_FEATURE_GIT=true` 不会让主服务加载 git 模块；用 `ce-git.json` 启动也不会替你起容器。接入已有 Forgejo（别的机器或既有实例）时本目录保持关闭，只配主服务侧连接。

## 2. 连接配置（`AOS_GIT_CONFIG_FILE`）

四键中唯一需要写文件的是它：指向一份**受运维管理**的 JSON，内容在进程启动期解析一次，运行期不再回读。宿主的要求：值必须是**绝对路径**（相对路径会随启动 cwd 漂移，启动期拒绝）；键为空串时不读文件、投影空连接（默认装配不受影响）；**配了路径却读不出来**（文件缺失、JSON 非法）则启动直接失败，不降级成「没有 Git 能力」。

完整样例（文件里只有连接；凭据一律写引用，不写值）：

```json
{
  "connections": [
    {
      "id": "primary",
      "baseUrl": "http://forgejo:3000",
      "provisionTokenRef": "{env:AOS_GIT_PROVISION_TOKEN}",
      "requestTimeoutMs": 15000,
      "maxConcurrentRequests": 16
    }
  ]
}
```

| 字段 | 必填 | 规则 |
|---|---|---|
| `connections` | 是 | 至少一条，连接 `id` 不得重复；空数组即启动失败 |
| `connections[].id` | 是 | `^[a-z][a-z0-9-]{0,63}$`；它会进日志与绑定表，限定小写字母/数字/连字符避免大小写与转义歧义 |
| `connections[].baseUrl` | 是 | **只允许 origin**：http/https、无路径/查询/片段、不得内嵌用户名或口令。运行时请求 URL 一律以它为基准拼接，用户请求不能覆盖 |
| `connections[].provisionTokenRef` | 是 | 必须是 `{env:NAME}`，且 `NAME` 必须已被宿主注入（见 §3）；未声明的引用当场拒绝 |
| `connections[].requestTimeoutMs` | 否 | 默认 `15000`，范围 1000–120000；越界**拒绝而不是夹取** |
| `connections[].maxConcurrentRequests` | 否 | 默认 `16`，范围 1–64（单连接在途请求闸） |

未知键会被拒绝（配置是严格对象），拼错的键不会静默忽略。错误消息只带字段路径与变量名，**不回显** `baseUrl` 与任何密钥值——`baseUrl` 可能被误写成内嵌凭据的 URL。典型取值：容器内主服务填 `http://forgejo:3000`，本地源码运行填 `http://127.0.0.1:3210`（与 `FORGEJO_HOST_PORT` 一致）。

## 3. 环境变量

四个键的唯一声明处是 `packages/common/git/fenix.module.ts`（宿主 `env.ts` 不重复声明，重复会在启动期被拒绝），全部改动需重启；只有模块进入装配 profile 时才汇总这些声明，因此默认 `ce.json` 的装配不读它们。模板见 `.env.example` 与 `docker/main/.env.example` 的「模块 git」段。

| 键 | 默认值 | 密钥 | 用途 |
|---|---|---|---|
| `AOS_GIT_CONFIG_FILE` | 空串 | 否 | 连接配置 JSON 的绝对路径，见 §2 |
| `AOS_GIT_PROVISION_TOKEN` | 空串 | **是** | Forgejo **初始化**凭据：建仓库、建 Webhook、绑定既有仓库时使用；只允许被初始化动作与管理面消费，不得常驻在 AOS 请求处理路径上 |
| `AOS_GIT_SERVICE_TOKEN` | 空串 | **是** | Forgejo **日常读写**凭据：受限服务账号，仓库绑定通过 `{env:AOS_GIT_SERVICE_TOKEN}` 引用它，普通业务只走这一枚 |
| `AOS_GIT_FORGEJO_URL` | `http://127.0.0.1:3210` | 否 | 部署侧**探活**地址（不是模块运行时地址，运行时地址取 §2 的 `baseUrl`）；容器内部署应设为 `http://forgejo:3000` |

两枚 token 的差异必须保持：初始化凭据能建仓库与 Webhook，一旦被绑定记录引用，任何拿到该绑定的消费者都间接获得管理面能力，因此绑定**不得**引用它（包内比对凭据值拒绝，不只是看引用名）；日常凭据按最小权限在 Forgejo 侧建服务账号生成。两枚都是密钥材料，只进主服务 env（dev 是仓库根 `.env`，生产是 `docker/main/.env`），**不进 `docker/deploy.env`、不进 compose、不进日志**。

## 4. 启动顺序

1. **部署 Forgejo**：`cp docker/git/.env.example docker/git/.env` 并填 `FORGEJO_DB_PASSWORD`（与库里的口令同值），`docker compose -f docker/git/docker-compose.yml up -d`；就绪判定 `curl -fsS http://127.0.0.1:3210/api/healthz` 返回 200、`docker compose ... ps` 为 healthy。库不可达时容器会反复重启（日志里是 `InitDBEngine` 的连接失败重试）。**接入已有实例时跳过本步**，只配主服务侧连接。
2. **首次初始化 Forgejo**：建首个管理员（`INSTALL_LOCK` 已开，不会有网页安装向导）、在 Forgejo 里建 AOS 用的服务账号与访问令牌（按最小权限），细节见 `docker/git/README.md`「首次初始化」。
3. **应用 DDL 迁移**：`bun run db:migrate`（本次是 `drizzle/0033_common-git-tables.sql`）；有存量数据搬迁时再跑 `bun run run-data-migrations`（本批没有数据迁移）。发布顺序固定 DDL → 数据 → 应用，不得颠倒；未启用 git 的部署同样要执行这一步（表属于主服务的库，与装配无关）。
4. **配置主服务**：设 `AOS_GIT_CONFIG_FILE`（绝对路径，指向 §2 的 JSON）、`AOS_GIT_PROVISION_TOKEN`、`AOS_GIT_SERVICE_TOKEN`、`AOS_GIT_FORGEJO_URL`。
5. **用启用了 git 的装配启动主服务**：profile 换成 `deploy/assembly/ce-git.json`（`RCS_ASSEMBLY_PROFILE_PATH` 传绝对路径，或由发布入口固定），启动主服务。启用 git 却没有任何连接时，模块在产生副作用前报错并指向 `AOS_GIT_CONFIG_FILE`——这是配置缺失的判定信号，不是「没有 Git 能力」的降级。
6. **初始化绑定（后续任务，本版不可用）**：`bun run scripts/git-bootstrap.ts` 与 `bun run git:bootstrap` **尚未实现**（随 T07 交付），仓库内没有可执行的自动初始化命令。在此之前只能在 Forgejo 侧手工建仓库与令牌；绑定的自动化登记同样没有入口（宿主管理接口与初始化脚本都未交付），`git_repository_bindings` 目前只由包内 `bindExistingRepository` 写入，而本版没有调用它的外部入口。
7. **调用侧使用**：消费者经 `GitService.createScopedClient` 取受控作用域。本版没有任何对外路由暴露 Git 能力，普通消费者（工单，未实现）也尚未接入，因此第 5 步之后**没有终端用户可见的功能**——请按「接入层已就绪、消费方待交付」理解。

## 5. 共享 PostgreSQL 的库与角色

Forgejo 使用**独立数据库与账号**，但可共用 `docker/common/` 的 Postgres 实例。库与角色**不在仓库内自动化**：共享实例往往早已初始化，`docker-entrypoint-initdb.d` 那时不会再执行，而库必须在 Forgejo 首次启动前存在（建表与迁移由 Forgejo 自己跑，连不上库就直接退出）。步骤（启动 Forgejo 之前做，名称与 `docker/git/.env` 的 `FORGEJO_DB_*` 一致）：

```bash
docker run --rm -it --network fenix-server postgres:16-alpine psql -h postgres -U rcs -d postgres
```

```sql
CREATE ROLE forgejo LOGIN PASSWORD '<与 FORGEJO_DB_PASSWORD 同值>';
CREATE DATABASE forgejo OWNER forgejo ENCODING 'UTF8';
-- 口令不一致时交互式重设（不写进 SQL 与 shell 历史）
\password forgejo
```

重跑报 `already exists` 即跳过；`.env` 与库里的口令不一致时用 `\password forgejo` 把库里改成一致的那个。备份边界：仓库、附件与 `app.ini` 在 `docker/git/data/forgejo`（随目录整体备份），Forgejo 的库在共享实例里，另用 `pg_dump` 备份。

## 6. 排障

| 症状 | 定位 | 处置 |
|---|---|---|
| 启用 git 后主服务启动失败，消息「启用 git 必须配置 `AOS_GIT_CONFIG_FILE`（当前没有任何连接）」 | 该键为空或未注入；模块只在 git 进入 profile 时才被构造，因此只会出现在 `ce-git.json` 的装配上 | 配齐 §2 与 §3 的四个键后重启 |
| 启动失败，消息「`AOS_GIT_CONFIG_FILE` 必须是绝对路径」/「读取失败」/「校验失败」 | 宿主投影阶段（`apps/server/src/bootstrap/module-configs.ts`） | 路径改绝对；核对文件权限与 JSON 形状；校验失败消息带字段路径，按 §2 规则修 |
| 启动失败，消息「`AOS_GIT_CONFIG_FILE connections[N].provisionTokenRef` 引用了未声明的密钥 X」（或「引用的密钥 X 未提供值」） | 配置引用了 manifest 未声明的键，或该键在当前装配里没有值 | 引用只能指向 §3 的两枚 token 键，且必须有值 |
| 业务调用报 `FORBIDDEN`，消息「绑定 … 的凭据引用引用了未声明的密钥」/「未提供值」/「指向初始化凭据」 | 绑定记录的 `credential_ref` | 把引用改指受限服务凭据并填值；不得让绑定引用 `AOS_GIT_PROVISION_TOKEN` |
| 业务调用报 `NOT_FOUND`，消息「连接 … 未在 `AOS_GIT_CONFIG_FILE` 中配置」 | 绑定记录的 `connection_id` 与配置文件里的连接 `id` 不一致 | 对齐两处 id（绑定一行只认一个连接） |
| 业务调用报 `FORBIDDEN`，消息「仓库绑定 … 不属于当前组织」 | 调用方传入的组织与绑定记录的 `organization_id` 不一致 | 核对创建作用域客户端时注入的组织上下文；消息刻意不透露绑定属于哪个组织 |
| 业务调用报 `UNAVAILABLE`/`RATE_LIMITED`（读已自动重试 2 次） | Forgejo 不可达、被限流或网络故障 | `curl -fsS "$AOS_GIT_FORGEJO_URL/api/healthz"`；`docker compose -f docker/git/docker-compose.yml ps` 与容器日志。**Forgejo 不可达不阻断主服务启动**（依赖声明 `required: false`），只是 Git 能力降级 |
| 业务调用报 `WRITE_UNCERTAIN` | 写请求超时、连接中断，或收到成功状态但响应体无法解析——**远端是否落库未知** | **禁止盲目重发**：重放会造出第二份对象。先按 `operationId` 在运维日志里定位这次调用，再带外键坐标（连接、`owner/name`、Issue 编号或消息标识）到 Forgejo 侧核对是否已经落库；确认未落库才重试，确认已落库则按既有对象收敛。调用方自行生成的恢复核对流程属 T02/T04，本版**没有自动核对**，只能人工处置 |
| 模块日志只有 `git.module.ready` 与连接 id 列表 | 正常：进程启动时模块只记连接拓扑，不含凭据；适配器首次调用才连 Forgejo | 若期望的出站请求没有发生，先确认调用方是否真的调用了作用域客户端 |

## 7. 回滚边界

- **关闭 Git 能力**：把 profile 换回默认 `deploy/assembly/ce.json` 并重启主服务。模块不再加载，进程不读连接配置、零出站请求；`/web/system/modules` 随之不再返回 `git`。
- **停 Forgejo 容器**：`docker/deploy.env` 的 `FENIX_FEATURE_GIT=false` 后重新 `up`（或对该 Compose 项目 `down`）。容器停止不影响已升级的应用代码。
- **不 drop 表、不删除仓库**：回滚只动装配与容器开关，四张账本表与 Forgejo 里的仓库、Issue、评论、附件一律保留，重新启用时数据仍在。
- 回滚前确认没有未确认的操作：`WRITE_UNCERTAIN` 的写入必须保留待核对（按 `operationId` 与消息标识回源），不能被回滚顺手清掉。
