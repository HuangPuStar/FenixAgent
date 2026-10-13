# ADR: 站点发布面的发布范围解释权

- **日期**：2026-09-25
- **状态**：✅ 已确认（边界裁定登记，§10.7.4）

## 背景

`agent_site_app` 是受控资源：它在 `packages/resources/agent-config/src/server/access/agent-site-app-resource.ts` 注册，声明了归属模式（组织 + 归属用户）与动作集，管理面（`/web/agent-sites`、绑定与卸载）一律经 `facades/agent-site-app-facade.ts` 做授权，读口径由 `services/agent-site-app-service.ts` 作为业务条件下推、与平台授权谓词 AND 成同一条 SQL、由仓储经 `ResourceQueryConstraint` 交给平台查询端口。这段没有争议。

争议在**发布面**：`packages/resources/agent-config/src/server/routes/agent-sites-proxy.ts` 代理 `/web/site/deploy/:appId/*` 的对外访问，并在路由内自行解释 `visibility`（四值：`private` / `org` / `authenticated` / `public`）与访问者的组织、用户标识，决定放行、重定向还是 403。路由内的判定是刻意为之的——它在文件头写明了裁定，但**这份裁定此前没有在 docs 里登记**，与 §10.7.4「边界豁免与依赖残留必须逐条登记并写明 owner 与移除条件，未登记的残留为零」不符。本 ADR 就是这份登记的正文。

需要说清楚的是：`visibility` 这一列在两处出现，含义不同。

| 面 | 列的角色 | 判定依据 | 判定者 |
| --- | --- | --- | --- |
| 管理面（资源行） | 资源受众：谁能读/改这一行资源 | `ResourceScope`（平台授权谓词）+ 业务条件 | `AccessControlModule` + Facade |
| 发布面（已部署站点） | 发布范围：这个访客能不能打开这个 app | 发布记录的四值（`private` / `org` / `authenticated` / `public`）+ 访客身份 | 发布面路由 |

## 决策

**发布面的发布范围解释权留在发布面路由（`routes/agent-sites-proxy.ts`），并登记为已裁定的边界，不移交给 `AccessControlModule`。**

依据是 §3.3 第一段末句「匿名访问由 Site 等资源专属发布字段或发布实体表达」：发布面**没有 actor**、不产生受控查询（不构造 `ResourceQueryConstraint`、不读资源行），也不判定任何资源动作，因此不落入同段「资源领域、route、前端和普通 Repository 不得自行解释组织、用户、角色或 `visibility`」的射程——那一条约束的是资源受众与查询约束的下推。§10.3 第 2 条同理：它管的是「外部资源动作」，而访客打开一个已部署的站点不是资源动作。

发布面读取的投影**只含判定所需的三个字段**（`visibility` / `organizationId` / `userId`），不含 `platform_token` 等敏感列；定位站点行（含 60 秒读缓存）由 Facade 的发布面入口完成，路由不接触仓储。

判定本身很短，四个取值各有明确归宿：`public` 直接放行；无身份访客一律 302；`private` 要求访客即创建者；`org` 要求同组织；`authenticated` 落在函数末尾的放行上，因此**没有显式分支**。列出这一点是为了避免被读成遗漏分支：它要表达的条件正是「已经过了『无身份 → 302』这一关」，所以有身份即放行。

同批登记的第二条：**站点读口径作为业务条件留在资源侧**（`services/agent-site-app-service.ts` 的发布范围条件）。它与上面的裁定同源——「发布范围」是站点资源自身的领域语义，不是平台受众列，因此它以具名业务条件的形式与授权谓词 AND 在同一条 SQL 上，而不是被搬到平台层。

### 边界（解释权不外溢）

- 管理面的读写一律经 Facade，发布面不参与；
- 发布面新增分支时**不得**引入资源行查询或资源动作判定；出现这类需求说明该判定已越出「发布范围」的语义，应回到管理面或提升为发布实体；
- 本裁定不构成「发布面可以用 `visibility` 表示平台受众」的先例。

## 考虑过的替代方案

| 方案 | 结论 |
| --- | --- |
| 发布面改走 `AccessControlModule` | ❌ 不成立：发布面没有 actor，也没有资源动作可判定；强行套用会为了满足形式而伪造主体或动作 |
| 把 `agent_site_app.visibility` 当作平台受众列注册进受控资源的 `visibility` 谓词 | ❌ 语义错位：该列的取值域与更新语义由发布范围决定（四值、以部署站点为单位），与 `ResourceScope` 的两值受众（`private` / `public`）不是同一件事；照搬会让站点部署的可见性受平台授权放宽影响 |
| 平台新增一等「发布实体」（发布范围随发布记录持久化，由平台统一裁决） | ⏳ 长期方向，见下「移除条件」。当前没有第二个发布面消费方，为单一实现建模平台层属于推测性抽象 |
| 不登记，仅在路由文件头写明 | ❌ 与 §10.7.4 冲突：边界裁定必须在 docs 可见，读代码的人不该靠翻路由文件才知道这是被批准的例外 |

## 后果

- 发布面与资源授权面各自单一职责：管理面回答「主体能读/改哪些资源行」，发布面回答「访客能否打开已部署站点」；
- 这份裁定从此可被引用：路由文件头保留判据摘要，完整理由与替代方案在本 ADR；
- **owner**：`@fenix/agent-config` 的站点发布面（`src/server/routes/agent-sites-proxy.ts`）；
- **移除条件**：平台出现一等「发布实体」抽象（发布范围随发布记录持久化、由平台统一裁决）时，发布面改为委托该实体，本文件与路由内的本地判定一并删除；在此之前，发布面新增的每一处解释分支都要回到本 ADR 复核。
- 已知的观测缺口：发布面的拒绝（302 / 403）目前只有路由用例覆盖（`agent-config` 的站点代理用例），没有端到端的对外访问回归。

## 相关文档

- 规范：`docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md` §3.3（资源领域与 route 的解释权边界）、§10.3 第 2 条（外部资源动作的授权归属）、§10.7.4（边界豁免逐条登记）
- 台账：`docs/design/ce-ee-refactoring/ce-standards-todo.md` 的 C1 行（站点受控资源化与其证据链）
- 代码：`packages/resources/agent-config/src/server/routes/agent-sites-proxy.ts`（裁定摘要）、`src/server/access/agent-site-app-resource.ts`（不声明 `visibility` 的理由）、`src/server/facades/agent-site-app-facade.ts`、`src/server/services/agent-site-app-service.ts`（读口径）
- 相邻 ADR：`docs/adr/2026-09-24-knowledge-bases-api-list-contract.md`（同为「先登记再改/再留」的合同留痕）
