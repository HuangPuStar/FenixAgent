# 35. 架构文档必须区分现状、目标态、在途 rollout 和已废弃假设

| 属性 | 结论 |
| --- | --- |
| 优先级 | P2 |
| 置信度 | 高 |
| 影响 | Agent/维护者依照不存在的模块、命令或保证修改代码，ADR 被误读为已落地 |

## 对抗判决

领域 CONTEXT/ADR 描述了清晰的 Orchestration/Chat 目标架构，但代码仍保留原始 relay 暴露、单进程 commandId、异步 Y.Doc 恢复和重复 Dispatcher 等过渡实现。frontend guide 声称统一 useRequest/error，又有大量 raw Result；仍引用已删除/迁移的前端 ACP 路径。文档要求不存在的 `check:deps`，包数也从 11 漂到 14。

## 已核验证据

- `spec/global/CONTEXT.md` 将 orchestration 标为 completed、Chat 标为目标/在途；runtime 审计证明关键 ownership 未闭合。
- Chat ADR 明确把 event log/lease、单实例、process Map dedup 列为延后假设；运行代码却未在 capability/readiness 中暴露限制。
- `docs/developer/guide/frontend-development.md` 描述统一 request/useRequest 与 error/retry，实际 [25](./25-repair-frontend-request-seam.md) 存在双语义和假成功。
- 文档中的 `bun run check:deps` 在 `package.json` 无对应 script。
- 项目地图称 packages 11 个，实际有 14 个 package manifest。
- `docs/arch/12-files.md` 等文档混合“当前实现、理想状态、P1 待办”，读者难以判断哪条是不变量。

## 架构诊断

文档没有 lifecycle/status interface：ADR 的“决定”、设计的“目标”、实现的“能力”和 rollout 的“完成度”共享叙事语气。随时间变化的 topology/包数/命令手工复制，必然漂移。

## 目标方向

- 每篇架构文档标明状态：current / target / transitional / superseded，以及适用 commit/schema/version。
- ADR 只记录长期决策、约束、替代方案和后果；rollout checklist 放 design/issue，不把“已决定”写成“已实现”。
- 对关键能力维护 machine-readable capability/invariant 清单：relay ownership、deployment mode、schema version、supported runtime。
- 包图、命令、环境变量、OpenAPI 等可生成内容从源码生成或在 docs build 校验，不手工复制数字。
- 在实现改变时，把 docs/ADR 更新列入 Definition of Done；失效内容明确 supersede，不静默重写历史决定。

## 分阶段整改

1. 先标记 Orchestration/Chat/Files 文档每段的 current/target 状态和未满足条件。
2. 修不存在命令、包数、路径和请求语义。
3. docs build 加命令存在、链接、env/schema、package count/graph 与示例编译检查。
4. 建立 ADR index 与 supersession 关系，设计文档关联对应整改编号/issue。

## 验收

- 新维护者只读文档即可准确回答“现在能否多副本/多消费者/跨标签页恢复”，不靠源码猜。
- 文档中的命令可执行、路径存在、生成数据与源码一致。
- 一个 target 状态只有通过对应 fitness tests 才能标 completed。

## 非目标

不是把所有实现细节写进 CONTEXT。稳定领域术语和不变量留在高层；易变拓扑、API、命令由更近的文档或生成物承担。
