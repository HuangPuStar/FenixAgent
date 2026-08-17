# 24. API 的运行时 schema、类型和 handler 必须来自同一契约

| 属性 | 结论 |
| --- | --- |
| 优先级 | P1 |
| 置信度 | 高，Zod 剥离行为已实测 |
| 影响 | 幻影字段、wrong-resource 操作、OpenAPI/前端与运行时不一致 |

## 对抗判决

Task 前端声明 list 支持 `agentId` 并在 Agent 面板传入；handler 也读取它，但绑定的 Zod query schema 没有该字段。Elysia 校验后未知字段被剥离，handler 永远拿不到 agentId。每个 Agent 面板因此展示当前用户/组织的全部 task，用户可在 A 面板触发/启停 B 的任务。

## 已核验证据

- `web/src/api/tasks-v2.ts:58-60`：前端类型和请求包含 agentId。
- `web/src/pages/agent-panel/TasksPanel.tsx:53-61`：按当前 agentId 加载。
- `src/routes/web/tasks-v2.ts:61-87`：handler 读取并宣称支持 agentId。
- `src/schemas/task-v2.schema.ts:90-94`：运行时 schema 只有 keyword/type。
- 实测 schema 对 `{agentId:"agent-A",page:"1",pageSize:"50"}` 输出只含 page/pageSize。

## 架构诊断

同一个 protocol interface 被前端 TypeScript、Zod、route cast、OpenAPI detail 和 service filter 重复定义。编译通过不能证明边界保留字段；`as Record`/`as any` 又绕开了 schema 推导。契约 seam 实际有五个真相源。

## 目标方向

- request/response runtime schema 是单一源；handler 类型、OpenAPI 和前端 client/type 从它导出或生成。
- handler 只消费验证后的 typed query/body，不重新 cast 原始对象。
- 默认严格处理未知字段：对稳定外部 API 返回验证错误；内部 web API也至少在 contract test 中发现漂移。
- DTO 在边界转换为领域 command/query；数据库/领域/ViewModel 类型不直接复用协议对象。
- mutation 的资源作用域在 service 再校验，不能只信 UI filter。

## 分阶段整改

1. 立即补 agentId schema 与后端过滤测试，并修 TasksPanel mutation 的错误语义。
2. 建立 route schema → client contract 的生成/共享路径，从 Tasks V2 试点。
3. 增加 OpenAPI snapshot/consumer contract 测试，扫描“handler 读取 schema 未声明字段”。
4. 迁移高风险 Knowledge、Workflow、File API 后，再扩大到全仓。

## 验收

- 不同 agentId 只返回各自任务；尝试操作未属当前 Agent 的 task 有明确授权/作用域语义。
- 修改 schema 时前端类型、OpenAPI snapshot 和 contract test 同步失败/更新。
- 不再依靠读源码字符串的测试证明请求方法存在；测试真实解析和交互。

## 误报排除

这是同一用户/组织内的 wrong-agent 操作，不是数据库租户越权；严重性来自页面语义和副作用目标错误。
