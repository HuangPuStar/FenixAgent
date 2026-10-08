# 边界豁免与依赖残留登记

§10.7 完成证据第 4 条要求「边界豁免与依赖残留必须逐条登记并写明 owner 与移除条件，**未登记的**残留为零」。
本文是该要求的唯一登记处：凡是刻意保留、而非本轮消除的边界绕行都在此列一行。审核「残留是否为零」时，
以本文的行数与代码侧的登记段（各自在文件头）能一一对上为准。

## 登记规则

- **一行一条**：写明豁免内容、位置、依据（引 §原文）、owner、移除条件。
- **详述留在近处**：本文只给结论与定位；理由、替代方案与证据放在代码文件头的登记段或 ADR 里，本文负责指路。
- **只在代码里写不算登记**：仅在文件头写明与本文的要求冲突（读代码的人不该靠翻文件才知道这是被批准的例外）；
  文件头的登记段是**摘要**，本文才是登记本身。
- **新增即登记**：改动引入新的绕行时同批补行；移除条件一旦成立，先删代码再删本行。

---

## 1. Agent Sites 发布面的发布范围解释权

| 项 | 内容 |
| --- | --- |
| 豁免内容 | `routes/agent-sites-proxy.ts` 在对外访问路径上自行解释 `visibility`（四值）与访问者的组织、用户标识，决定放行 / 重定向 / 403，不经 `AccessControlModule` |
| 位置 | `packages/resources/agent-config/src/server/routes/agent-sites-proxy.ts` |
| 依据 | §3.3 第一段末句（匿名访问由 Site 等资源专属发布字段或发布实体表达）；§10.3 第 2 条管的是「外部资源动作」，而访客打开已部署站点不是资源动作——发布面没有 actor，也不构造 `ResourceQueryConstraint` |
| owner | `@fenix/agent-config` 的站点发布面（`src/server/routes/agent-sites-proxy.ts`） |
| 移除条件 | 平台出现一等「发布实体」（发布范围随发布记录持久化、由平台统一裁决）时，发布面改为委托该实体，本地判定整体删除 |
| 详述 | `docs/adr/2026-09-25-agent-sites-publish-face-visibility.md`（含替代方案与边界不外溢条款） |

管理面（`/web/agent-sites` 的读写）与本文无关：它一律经 `facades/agent-site-app-facade.ts` 授权，
`agent_site_app` 也已在 `access/agent-site-app-resource.ts` 注册为受控资源。

## 2. Sandbox `/api/system/*` 系统管理面绕过本包 Facade

| 项 | 内容 |
| --- | --- |
| 豁免内容 | 27 条系统管理端点跳过 `sandbox-pool-facade` 的范围决策层，直接调用 `services/sandbox-admin-service`（含仓储读取）与 cluster 侧两个客户端服务。**这条路径上具备跨组织读写能力**：不传 `organization_id` 时列出全部组织的池，`create` / `updatePool` 接受任意 `organizationId`，实例面接受任意 `userId`；沙盒资源池不在五张受控资源主表之列（无 `visibility`），因此这里没有 `AccessControlModule` 兜底——这是系统凭据的既定权限范围，不是遗漏 |
| 位置 | `packages/resources/sandbox/src/server/routes/api/sandbox.ts`（10 条）、`sandbox-cluster.ts`（13 条）、`sandbox-server.ts`（4 条） |
| 依据 | 这些端点由宿主 `systemApiAuthPlugin`（`RCS_SYSTEM_API_KEYS`）守卫，该守卫刻意不恢复用户 / 组织上下文，**没有 actor 可以传给 Facade**；调用方是平台运维者而不是某个用户，凭据本身就是判据。跨组织能力是「运维者管理全平台沙盒」这一职责的直接表达 |
| owner | `@fenix/resource-sandbox` 的 `/api/system/*` 系统管理面（`src/server/routes/api/**`）。用户面 owner 仍是 `/web/config/sandbox-pools` 这一条路由，两面不共享范围决策 |
| 移除条件 | ① 这些端点改为面向普通用户会话（必带 actor、必然要判归属）；② 平台定下「系统面与用户面共用同一门面」的统一契约；③ 沙盒资源池被收进受控资源表（届时系统面也要走 `AccessControlModule`）。任一成立时 27 条路由改为经 Facade（届时须为无 actor 的系统面新增入口） |
| 详述 | `packages/resources/sandbox/src/server/facades/sandbox-pool-facade.ts` 文件头的「系统管理面绕过本门面的登记」段 |

## 3. Machine 工作区上传的 `/api` 与 `/web` 两套实现

| 项 | 内容 |
| --- | --- |
| 豁免内容 | 「把 multipart 文件写进某个 environment 的 workspace」这一个业务动作存在两条独立实现：`/api` 面经 `machine-workspace-facade → services/api-workspace`，`/web` 面经 `machine-file-facade → services/agent-file-service`，与 §3.1「已发布的 `/api` 保留为调用同一 Facade 的薄协议 adapter」不符 |
| 位置 | `packages/resources/machine/src/server/routes/api/workspaces.ts`、`src/server/services/api-workspace.ts`（`/api` 面）与 `src/server/routes/web/fs.ts`、`src/server/services/agent-file-service.ts`（`/web` 面） |
| 依据 | 两面**不是同一份语义**：路径作用域（`user/` 子树 vs workspace 根）、远程落点（剥 / 不剥 `user/` 前缀）、单文件上限（50MB vs 100MB / 远程 20MB）、授权口径（组织 + 属主 vs 另加 `member` 403）、幂等与副作用（`opId` / `If-Match` / `file_changed` 事件）、相对路径校验集合、错误信封（`{error:{code,message}}` vs `{error:{type,message}}`）共 7 处实质差异。其中 `/api` 一面是**已发布的外部合同**，按 §3.1 其变更或退役须经独立 ADR、消费者盘点与迁移窗口，因此不与 `/web` 面强行合并 |
| owner | 两面都在 `@fenix/resource-machine`（`services/api-workspace.ts` 与 `agent-file-service.ts` + `file-backends.ts`） |
| 移除条件 | 给出「并入文件域 Facade」的裁定与迁移窗口后：`routes/api/workspaces.ts` 改调 `machine-file-facade`（协议形状与错误码在 adapter 内保持），`services/api-workspace.ts` 的第二套写入 / 校验 / 上限逻辑整体删除 |
| 详述 | `packages/resources/machine/README.md` 的「已知项」节（7 条差异逐条列证据与现状依据） |

## 4. Machine 的 service 直连 DB 未收敛到 repository（§1.4 残留）

| 项 | 内容 |
| --- | --- |
| 豁免内容 | `getMachineDatabase()` 的调用点除 3 个 repository 外还有 3 个 service（`registry.ts` / `registry-heartbeat.ts` / `remote-file-service.ts`），合计 28 处 |
| 位置 | `packages/resources/machine/src/server/services/` |
| 依据 | 属 §1.4 的边界收敛范围，本轮未做；已按「新增数据库操作一律进 repository、不沿此路径继续扩散」冻结现状 |
| owner | `@fenix/resource-machine` |
| 移除条件 | 这三个 service 的数据库读写迁入 repository 时，本行同步删除 |
| 详述 | `packages/resources/machine/README.md` 的「已知项」节 |

---

## 已排查、确认无需登记的形态

以下形态容易被误登记，此处显式排除，避免本文随误报膨胀：

- **前端页面内的取数**（如 `apps/web/src/pages/agent-panel/chat-workspace-artifacts.tsx` 解析 `environment.agentConfigId`）：
  前端规范 §2.5 允许页面取数，禁止的是**壳**取数；页面属「页面或域模块内」，不是豁免。
- **非受控资源的租户边界用「已认证 active organization」表达**（如知识库、沙盒资源池不接 `@fenix/access-control`）：
  这些资源不在五张受控资源主表之列、没有 `visibility` 列，其边界由会话守卫保证，属正常形态而非绕行。
- **`/api` 与 `/web` 共用同一 Facade 的薄 adapter 差异**（错误信封、分页夹紧等）：协议层差异属于 adapter 职责，
  只有**第二套业务实现**才需要登记（见上方第 3 行）。
