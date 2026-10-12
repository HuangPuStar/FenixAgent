# 工单（Tickets）运维说明

> 状态：实现基线（2026-10-12）。本文只写本版已落地的操作；未实现的脚本与流程逐条标注，不写成可执行步骤。
> 权威来源：模块行为以 [工单模块架构](../arch/29-tickets.md) 为准；Git 连接配置、Forgejo 编排与共享库创建以 [公共 Git 运维说明](./common-git.md) 为准；编排与 feature 开关以 [Docker 编排体系](./docker-topology.md) 为准（本文不复述它们的细节）。

## 1. 组件与两层开关

| 组件 | 落点 | 开关 |
|---|---|---|
| 工单模块（`@fenix/resource-tickets`） | 主服务进程内的模块 | 应用装配：`deploy/assembly/ce-tickets.json` + `RCS_ASSEMBLY_PROFILE_PATH` |
| Forgejo（仓库与工单的事实源） | `docker/git/docker-compose.yml` 独立 Compose 项目 | 部署 feature：`docker/deploy.env` 的 `FENIX_FEATURE_GIT`（默认 false） |
| 五张工单表 | 共享 `postgres` 里主服务自己的库 | 无开关：DDL 迁移与装配无关，任何 profile 都可执行 |

工单模块**依赖** Git 模块：profile 必须同时列 `git` 与 `tickets`（`ce-tickets.json` 已经如此）。只列 `tickets` 会在启动期报「模块 tickets 依赖未启用模块 git」，不会静默降级。

两层开关互不自动映射：`FENIX_FEATURE_GIT=true` 只起 Forgejo 容器，不会让主服务加载工单；用 `ce-tickets.json` 启动也不会替你起容器。工单**不新增**任何环境变量与 `FENIX_FEATURE_*` 开关。

## 2. 启用步骤

1. **准备 Git 侧**：按 [公共 Git 运维说明](./common-git.md) §2–§4 部署并初始化 Forgejo、配好 `AOS_GIT_CONFIG_FILE` 连接文件与两枚 token。连接文件里 `connections[].id` 的值就是开通工单时要传的 `connectionId`。
2. **确认 DDL 已应用**：见 §4；表与模块开关无关，未启用工单的部署同样要迁移。
3. **构建含工单的浏览器产物**：
   ```bash
   bun run generate:web-contributions --profile deploy/assembly/ce-tickets.json
   bun run build:web
   ```
   产物只有一份：只改部署配置不会让旧 bundle 获得工单页面。生成物在版本控制内，默认门禁按 `ce.json` 的产物逐字比对，构建后如需回到默认产物运行不带 `--profile` 的 `bun run generate:web-contributions`。
4. **用含工单的装配启动主服务**：把 `RCS_ASSEMBLY_PROFILE_PATH` 指向 `ce-tickets.json` 的**绝对路径**（容器内是 `/app/deploy/assembly/ce-tickets.json`，源码运行用 `$PWD/deploy/assembly/ce-tickets.json`），重启生效。
5. **自检**：`GET /web/system/modules` 的 `data.modules` 含 `git` 与 `tickets`、`data.web` 含 `tickets`；控制台出现「工单」入口。任一不满足时先看排障表，不要用改前端的方式绕过。

## 3. 开通组织工单项目

开通是组织级管理动作，由组织 `owner` / `admin` 调用（`member` 会得到 403）；组织还没有项目时控制台列表页显示「尚未开通」，**不发任何工单请求**，这是预期行为。请求需要 `Idempotency-Key`（8–128 位字母、数字、下划线或短横线），一次用户动作一个键，重试复用同一个。

`create`（在凭据账号下新建私有仓库）：

```bash
curl -fsS -X POST "https://<host>/web/ticket-projects/default" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 9f2c7a1b4e6d" \
  -d '{"connectionId":"primary","mode":"create","repository":{"owner":"aos-service"}}'
```

`bind`（绑定既有仓库，`name` 必填，先按 `owner/name` 回源校验可访问）：

```bash
curl -fsS -X POST "https://<host>/web/ticket-projects/default" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 1b8e5d3a7c02" \
  -d '{"connectionId":"primary","mode":"bind","repository":{"owner":"aos-service","name":"aos-tickets-org"}}'
```

结果与后续动作：

- **200** `{ project, operation }`：项目已落库并成为该组织的默认项目。
- **202** `{ operationId, status: "uncertain" }`：上游写入结果未定。**不要重发**（同键重发只会再拿 202 或 409）；用 `GET /web/ticket-operations/:operationId` 复核，该接口只对发起人本人可见，其余一律 404。自动恢复核对未实现，确认前不要手工重复开通。
- **409** `REPOSITORY_ALREADY_BOUND`：同名仓库存在但归属未确认（或绑定已归别的组织）。改用 `bind` 显式绑定；已被别的组织占用的绑定不会成功。
- **暂停与恢复**：`PATCH /web/ticket-projects/default`，body `{"status":"paused"}` 暂停组织工单（只停写、读取与历史保留），`{"status":"active"}` 恢复；不带 `defaultProjectId` 时作用在当前默认项目上，没有默认项目返回 404。该接口是数据库事务内的本地变更，不需要幂等键。
- **切换默认项目**：`PATCH` 传 `{"defaultProjectId":"<uuid>"}`；目标处于暂停状态时返回 409（先恢复为 `active` 再切换）。
- **开通自检**：`GET /web/ticket-projects` 的 `state` 应为 `ready`，并给出 `defaultProjectId`。

## 4. 迁移

- 本模块的迁移是 `drizzle/0034_tickets-tables.sql`（五张表、索引与约束），随主服务迁移链交付。
- 执行：`bun run db:migrate`；生产入口是 `scripts/migrate.ts` 构建出的 `migrate.js`。迁移走 drizzle journal，对多实例并发启动幂等。
- 未启用工单的部署同样要执行这一步：表属于主服务的库，与装配无关；不迁移只会在启用后集中报错。
- 本批是纯 DDL、无存量回填，**不跑** `bun run run-data-migrations`。
- 发布顺序固定 DDL → 数据 → 应用，不得颠倒。

## 5. 关闭与回滚约束

- **关工单、保留 Git**：启动 profile 换成 `ce-git.json`（只从 `resources` / `web` 移除 `tickets`，保留 `git`）。若浏览器产物仍含工单贡献，`data.web` 不再含 `tickets` ⇒ 入口隐藏、`/agent/tickets/*` 显示「未启用」、不发请求。
- **完全关闭**：换回 `ce.json`（同时不启用 Git 能力）；进程不读连接配置、零出站请求。
- **只动开关**：**不 drop 五张表、不删 Forgejo 仓库 / Issue / 评论 / 附件、不删项目与绑定记录**。`uncertain` 操作的 `intent` 原文与结果保留，恢复后按 `operationId` / `message_id` 核对。
- **不强行降级**：旧应用版本若读不懂新 schema，停止回滚、改用经过验证的前向修复，不得删数据强行降级。
- **重新启用**：确认产物含工单贡献（用 `ce-tickets.json` 生成并构建过）→ 启动 profile 指回 `ce-tickets.json` → 组织管理员确认项目状态。暂停中的项目**不会**因重新开通被悄悄恢复成默认，这是刻意的运维边界。

## 6. 排障

| 症状 | 定位 | 处置 |
|---|---|---|
| `/web/ticket-projects` 或 `/web/tickets/*` 一律 404 | 工单模块未装配（启动 profile 不含 `tickets`），或路由贡献未注册 | 看 `GET /web/system/modules`：`data.modules` 缺 `tickets` 就换用 `ce-tickets.json` 重启；已含 `tickets` 仍 404 说明请求打到了别的副本，核对滚动发布是否落在一致 profile 的后端集合 |
| 手工输入 `/agent/tickets` 显示「模块 tickets 未启用」 | 该 bundle 不含工单贡献（或服务端已关闭） | 默认 bundle 下是预期行为；要用的部署必须用 `ce-tickets.json` 重新生成贡献并重建 |
| 入口可见但接口 404，或服务端可用但界面没有入口 | 构建期 bundle 与运行期 profile 不一致 | 两者由同一份 `/web/system/modules` 对齐：重建产物或改启动 profile，不要在两处分别打补丁 |
| 写路径返回 202 `{status:"uncertain"}` | 上游写入结果未定，或本端已有在途/未定写入 | **不重发**；`GET /web/ticket-operations/:operationId`（仅发起人）复核。运维可直读 `ticket_operations`：`status=dispatching` 表示在途或崩溃残留、`step` 给出卡点（`dispatching` / `project_ready` / `index_written` / `upstream_failed` / `owner_mismatch`）；自动恢复核对未实现，需带 `message_id` 或预留仓库名到 Forgejo 侧人工核对 |
| 写路径返回 409 `IDEMPOTENCY_CONFLICT` | 同一个 `Idempotency-Key` 被用于不同请求内容 | 换新键重试；内容未变的合法重试应复用原键（会拿到原结果而不是重复创建） |
| 开通返回 409 `REPOSITORY_ALREADY_BOUND` | 同名仓库已存在但无法确认归属，或绑定已归别的组织 | 改用 `mode: "bind"` 显式绑定；确认目标仓库与绑定归属后再操作 |
| 写路径返回 503 `TICKETS_PAUSED` | 组织/项目被暂停 | 由管理员 `PATCH /web/ticket-projects/default` 传 `{"status":"active"}` 恢复；读取路径不受暂停影响 |
| 读或写返回 503 `GIT_UNAVAILABLE` / `GIT_RATE_LIMITED` | Forgejo 不可达、限流，或绑定被暂停 / `tickets` 消费者授权被收回 | 按 [公共 Git 运维说明](./common-git.md) §6 探活与处置；再核对绑定 `status` 与 `allowed_consumers.tickets`。读路径对可重放失败自动重试 2 次，写路径不重放 |
| 开通返回 400 `GIT_OWNER_MISMATCH` | `create` 建仓响应的 owner 与请求声明不一致（该账号下建不了） | 在凭据账号下建仓，或改用 `bind` 接管既有仓库；请求里的 owner 不会被当作授权依据 |
| 列表数据停在开通前、行级 `sync_status` 长期为 `ready` | 事件同步未实现，索引只由创建路径写入 | 预期行为：在 Forgejo 侧直接新建或修改的工单不会出现在列表（详情可回源看到最新正文）。不要在启用前承诺「列表与仓库实时一致」 |
| 列表页提示「索引未同步到最新」 | 行级 `sync_status = stale` | 当前没有写入 `stale` 的代码路径；出现即说明运行了后续版本的同步逻辑，按该版本的口径处置 |

## 7. 既有风险提示

1. **索引不完整**：本版列表只反映创建路径写入的索引行，Forgejo 侧的后续改动、评论与标签同步都不进来；面向用户的说明不要把它描述成「仓库的完整镜像」。
2. **未确认写入需人工核对**：202/`uncertain` 的账本行保留 `intent` 原文与 `message_id`，自动回源核对未实现；关闭与回滚都不得清除这些行。
3. **幂等键由调用方持有**：管理面调用方必须按「一次动作一个键」使用；同键不同内容会被 409 拒绝，键格式不合规会在路由层直接 400。
4. **凭据与绑定是硬依赖**：写路径依赖 `AOS_GIT_SERVICE_TOKEN` 与绑定记录的 `credential_ref`；收回授权或暂停绑定会让读取报 503 而不是显示空列表——这是刻意设计，不要用「降级为空」掩盖。
5. **一个绑定只归一个组织**：跨组织共享仓库不在本版合同内，冲突报 409；需要共享时在各自组织新建项目并绑定不同仓库。
6. **控制台暂无管理面**：没有开通、切换默认与暂停的页面入口，本版只能用 §3 的接口操作，注意保留 `Idempotency-Key` 与调用记录。
