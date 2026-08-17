# 23. Knowledge 先恢复访问边界，再深化生命周期 Module

| 属性 | 结论 |
| --- | --- |
| 优先级 | P0（访问边界）/ P1（模块深化） |
| 置信度 | 高 |
| 影响 | 组织隔离失效、错误组织检索/图谱操作、远端与本地状态漂移 |

## 对抗判决

Knowledge runtime 的访问 helper 把 `isGlobal` 固定为 true，过滤表达式又包含 `|| true`。因此传入 organizationId 对检索、图谱生成/读取/删除/进度并不构成访问限制。相邻 CRUD 虽有组织过滤，runtime 没有复用；一个常量直接短路了整条租户 seam。

## 已核验证据

- `src/services/knowledge-runtime.ts:17-29`：`const isGlobal = true`，组织判断不可达。
- `src/services/knowledge-runtime.ts:99-117`：过滤含 `row.kbOrganizationId === orgId || true`。
- `src/services/knowledge-runtime.ts:247-305,323-421`：检索、图谱生成、读取、删除、进度复用该解析路径。
- `src/routes/web/knowledge-bases.ts:1110-1275`：上述能力由控制台接口直接暴露。
- `src/routes/web/knowledge-bases.ts` 约 1,422 行，`src/services/knowledge-provider/ragflow.ts` 约 1,471 行；route/provider 同时承担协议、访问、文件、远端任务和错误转换。

## 紧急修复

- 立即删除常量绕过，私有 KB 只允许 `organizationId` 匹配；共享必须有明确 grant，不把“global”从字段缺失/常量推导。
- 所有检索、图谱、资源、删除、进度和 Agent 绑定路径统一通过 KnowledgeAccess policy。
- 对两个组织建立访问矩阵测试：私有、显式共享、撤销、删除、脏绑定和直接调用 runtime。

## 架构诊断

Knowledge route 是浅 Module：调用者看似只调一个端点，implementation 的本地 metadata、RAGFlow dataset/document/task、文件预览、图谱状态和权限却在 route/UI 多点协调。访问策略没有成为 interface，provider-specific ID/status 泄漏到领域和 ViewModel。

## 目标方向

- KnowledgeAccess：唯一解析 actor/resource/action/grant，fail closed。
- KnowledgeLifecycle：拥有 create/import/upload/parse/reparse/delete 的 operation state、补偿和 reconciliation。
- Provider Adapter：把 RAGFlow DTO/status/error 转成独立领域模型，不承担授权。
- Query Projection：为列表/详情/资源/进度提供稳定 read model，前端不拼本地/远端状态。
- Content Rendering 使用 [6](./6-secure-untrusted-content-rendering.md)，异步操作使用 operation identity 而非页面 interval 猜终态。

## 分阶段整改

1. 访问边界热修 + 全动作租户矩阵。
2. 选“上传并解析一个资源”为最小垂直切片，引入 durable operation/reconcile。
3. 迁移图谱与删除，删除 route 中 provider-specific branching。
4. 拆分巨大文件时按 Module/状态机，不按 JSX/函数长度机械切片。

## 验收与观测

- 任意错误组织/撤销 grant/脏关联都不能进入 provider 调用。
- 远端 timeout、重复回调、RCS 写失败、进程重启后 operation 可查询并收敛。
- 指标包含 access deny、provider latency/error、drift、stuck operation 和 reconciliation outcome。

## 误报排除

这里不宣称所有 Knowledge CRUD 都跨租户；明确缺陷位于 runtime access helper，影响复用它的动作。相邻 CRUD 有过滤，恰好说明应收敛到一个权威策略而非继续复制。
