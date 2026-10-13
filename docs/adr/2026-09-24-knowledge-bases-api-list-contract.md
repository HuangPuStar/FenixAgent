# ADR: `/api/knowledge-bases` 列表的去重与 total 语义

- **日期**：2026-09-24
- **状态**：✅ 已确认

## 背景

`GET /api/knowledge-bases` 是已发布的对外列表接口（`packages/resources/knowledge/src/server/routes/api/knowledge-bases.ts`），响应信封为 `{ items, total, page, pageSize }`。它的可见范围是「本组织 ∪ 跨组织共享的全局知识库」：`items` 携带调用方本组织的知识库，也携带其它组织的知识库——后者就是该接口的既有对外语义。

**旧口径（提交 `76c8c408` 的父提交 `252e7eb8` 及更早）**：路由把两个数据源的结果**直接拼接**后切片：

```ts
const [orgRows, globalRows] = await Promise.all([
  listKnowledgeBasesByTeamId(authCtx.organizationId),  // 本组织
  listKnowledgeBasesGlobal(),                          // 全表
]);
const rows = [...orgRows, ...globalRows];
const total = rows.length;
return { items: rows.slice(start, start + pageSize), total, page, pageSize };
```

而 `listKnowledgeBasesGlobal()` 走的是 `knowledgeBaseRepo.listGlobal()`，其实现是无组织条件的整表查询（`db.select().from(knowledgeBase).orderBy(desc(updatedAt))`）。两个来源因此**不是互斥的**：本组织自己创建的知识库既在 `orgRows` 里、又在 `globalRows` 里。后果：

1. `items` 是多重集，本组织的知识库在列表里出现两次；
2. `total = |本组织| + |全表|`，大于实际可见行数；
3. 分页在拼接后的数组上切片，页边界按重复后的下标计算——同一行会在不同页各出现一次，`total` 描述的也不是分页所作用的那个集合。

**新口径（提交 `76c8c408` 起）**：可见集合收敛为**一份**结果集——仓储的 `visibleWhere()` 在 `includeGlobal` 为真时返回 `undefined`（可见行＝全表），否则返回组织条件；列表与计数共用同一份可见条件，排序与 `LIMIT/OFFSET` 与该条件挂在同一条 SQL 上。`total` 即该结果集的行数，页边界落在去重后的集合上。

本次变更是对**缺陷**的修正，而不是产品上选择了一种新的可见范围：新旧口径的可见行集合相同（本组织行 ∪ 全表行），差别只在「同一行被算了几次」。

## 决策

**保持单一可见集合的口径，并把它登记为对外合同的语义变更。** 具体到响应：

| 字段 | 旧口径 | 新口径 |
| --- | --- | --- |
| `items` | 多重集：本组织行出现两次（一次以「本组织」身份、一次以「全局」身份） | 集合语义：每个知识库至多出现一次 |
| `total` | 两个来源条数之和（本组织行数 + 全表行数） | 同一个可见条件的行数（本组织行 ∪ 全表行） |
| `page` / `pageSize` / 响应 schema | 不变 | 不变 |

生效窗口：提交 `76c8c408`（2026-09-24，`refactor(ce): 收敛台账九条缺口——发布编排、迁移归位、站点授权与 Facade 分层`）及其后所有版本；`252e7eb8` 及更早版本为旧口径。该提交之后工作区里「可见范围上移到 Facade（`listForExternal`）」的调整不改变本合同：它只是把可见范围的声明从路由搬到门面，`items` 与 `total` 的语义与上表一致。

按 §10.5.4「稳定消费者合同未经独立评审不得改变」，本 ADR 就是这次变更的评审记录（含消费者盘点）。

### 消费者盘点

- **仓库内无消费方**：实测 `git grep -n "api/knowledge-bases"` 全仓 45 处命中里**没有一处是 HTTP 调用方**——分别是本包的路由工厂、`src/server.ts` / `src/server/assembly.ts` 的导出、`fenix.module.ts` 与 README 及各处文档字符串、包内用例，宿主的两处（`apps/server/src/main.ts` 的聚合槽注释、`apps/server/src/__tests__/route-contributions.test.ts` 的端点清单断言），以及开发者文档对前端 client 文件名的引用。真实 HTTP 请求只出现在本包路由用例里（`git grep -nE '"(/)?api/knowledge-bases'` 命中的调用点全部在 `src/__tests__/api-knowledge-bases-routes.test.ts`）：前端只调 `/web/knowledgeBases`（`packages/resources/knowledge/web/api/knowledge-bases.ts` 虽与端点同名，实为控制台 client）；`e2e/`、`scripts/`、`tools/`、`side-project/`、`docker/`、`ui-sandbox/` 均无调用。
- **对外发布面**：该端点由 `@elysiajs/openapi` 发布在 `/docs/openapi/external/json`，供仓库外的 SDK、脚本与第三方集成读取；这些调用方无法在仓库内枚举，因此以本 ADR 作为语义变更与生效窗口的留痕，供发布说明引用。

## 考虑过的替代方案

| 方案 | 结论 |
| --- | --- |
| 维持两个来源拼接（不改） | ❌ 缺陷保留：列表出现重复项、`total` 偏大、翻页重复；与 `/web` 侧「一份可见集合」的语义长期分叉 |
| 在协议层对拼接结果做内存去重 | ❌ 只在结果上擦掉症状：仍需内存切片与另算计数，而重复项产生自错误的来源定义（全表本身已包含本组织行） |
| 加 `dedupe=false` 之类的兼容开关 | ❌ 把缺陷固化为长期合同。旧口径下没有任何可依赖的语义（「同一行出现两次」不是消费方会用到的信息），没有需要兼容的正确用法 |
| 一并收窄可见行集合（例如只并入显式共享的库） | ❌ 超出本次范围：那是可见范围的产品决策，本 ADR 只处理重复与计数 |

## 后果

### 积极后果

- `items` 与 `total` 描述同一个集合，翻页不重不漏；`total` 成为可用来判断「还有多少页」的数。
- 计数、排序与分页在同一条 SQL 上完成，可见集合不再经过内存拼接，行数增长不再放大协议层的开销。

### 风险与缓解

| 风险 | 缓解措施 |
| --- | --- |
| 外部调用方按旧 `total` 推导页数，升级后看到页数变少 | 数值只可能变小（等于旧值减去本组织行数），且变小正是修正；发布说明引用本 ADR |
| 外部调用方按「第 n 条一定是第 n 个知识库」定位（旧口径下该假设本身就因重复而不成立） | 属于对缺陷行为的依赖；`items` 去重后 `id` 稳定，调用方应按 `id` 而非下标定位 |
| 回归：日后有实现重新按来源拼接数组 | 已补语义回归用例：`packages/resources/knowledge/src/__tests__/api-knowledge-bases-routes.test.ts`（同一知识库只出现一次、`total` 等于去重后集合大小、页边界落在去重后的集合上），并由 `round46-knowledge-base-repository.test.ts` 在真仓储上断言 WHERE 条件与分页同条 SQL |

## 相关文档

- `packages/resources/knowledge/src/server/routes/api/knowledge-bases.ts` — 对外薄协议 adapter
- `packages/resources/knowledge/src/server/facades/knowledge-base-facade.ts` — 两条协议面各自的可见范围（`listForConsole` / `listForExternal`）
- `packages/resources/knowledge/src/server/services/knowledge-base-list.ts` — 可见集合的读模型
- `packages/resources/knowledge/src/server/repositories/knowledge-base.ts` — `visibleWhere` / `visibleOrder`
- `docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md` §10.5.4 — 稳定消费者合同的变更要求
