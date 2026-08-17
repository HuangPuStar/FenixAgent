# C8 · 文档升级与验收

> 来源：`docs/design/2026-08-04-yjs-chat-streaming-prd.md`（验收标准章节）
> 性质：收尾切片（必须在全部切片完成后）

## What to build

将 `docs/arch/19-yjs-chat-streaming.md` 从"目标设计基线"升级为"实现基线"（与 20 号文档相同路径），消除文档与代码的冲突表述，并同步相关文档。

### 实现内容

1. **19 号文档升级**，按已确认决策修订：
   - 状态头从"理想架构（目标设计基线）"改为"实现基线"，注明对齐日期与验证情况；
   - §6.2 修订：聚合边界改为"ACPChannel 是唯一协议边界，acp-link 私有帧在边界内规范化为事件"，删除"只接受 `method === session/update`"的绝对表述（Q6）；
   - §7.1 修订：ClientAction 信封字段明确"前端只发 `commandId`，`protocolVersion` / `expectedProjectionVersion` 服务端补充校验"（Q9）；
   - §5.4 修订：删除"双读窗口发布"表述，改为"一次性切换、无兼容窗口"（Q4）；
   - §7.2/8.2 修订：事件日志与租约标注为"不实现（评审决策，YJS CRDT 已保证文档一致性，`commandId` 去重承担防重复副作用）"，`leaseEpoch` 标注类型占位（Q5）；
   - §10 节：连接时序差异标注"二期优化项"（Q13）；
   - 模块表同步：`SessionLeaseManager` 标注占位、模块归属更新为 `packages/chat-channel` 子目录。
2. **`docs/arch/changes.md`**：新增本次改动记录（包合并、schema 切换、协议落地、状态机、权限 CAS、断链语义）。
3. **README 同步**：原 `packages/acp-server/README.md` 内容并入 `packages/chat-channel/README.md`（新语义：协议基础 + 聚合层 + 控制面）。
4. **最终验收**：全量验证（见验收标准），确认 19 号文档描述与代码一致（无文档宣称但代码不存在的机制，无代码存在但文档未记录的机制）。

## Acceptance criteria

- [ ] 19 号文档升级为"实现基线"，无与代码冲突的表述（逐节核对 Q4/Q5/Q6/Q7/Q9/Q13 修订点）
- [ ] `docs/arch/changes.md` 记录完整（包合并、引用迁移、协议、状态机、权限、断链）
- [ ] `packages/chat-channel/README.md` 就位，原 acp-server README 无残留
- [ ] `bun run precheck` 全绿；`bun run build:web` 通过；全部包内测试（含 C1-C7 新增）全绿
- [ ] 与 `docs/arch/19-yjs-chat-streaming.md` 逐节核对完成，确认文档即实现

## Blocked by

- C1–C7 全部完成
