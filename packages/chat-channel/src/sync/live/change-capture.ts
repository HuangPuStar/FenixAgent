// packages/chat-channel/src/sync/live/change-capture.ts
// 单事务变更捕获（设计 §6.1「每个改动一个事务、各得一条独立 update」）：把一次同步改动编码成一条可提交的更新字节。
//
// 「有没有变更」只能由 Yjs 自己产出的更新决定，不能用 `Y.encodeStateVector` 前后比对：纯删除只修改删除集、
// 不推进 state vector，比对会把删除判成「无变化」并静默丢弃（缺陷：`final` 的 `removeEntity` 不落库，封口后
// 若无新写入，幽灵实体永久留在客户端与服务端投影里）。判定基准取 `update` 事件——它由 Yjs 内部的
// `hasContent` 驱动：既没有新 struct 删除集也为空时不发事件，所以「无变化的事务」不会换来一条空更新，
// 批次序号区间也不会多出一格。

import * as Y from "yjs";

/**
 * 在 `doc` 上执行一次 `mutate`，返回这次事务产生的更新字节；事务没有产生任何变更时返回 `null`。
 *
 * 返回的字节相对调用前的状态向量编码：删除集也在这份字节里（`Y.encodeStateAsUpdate` 会带上文档的删除集），
 * 接收方按序号顺序应用即可把删除一并重建；对源文档重复应用幂等。
 */
export function captureChange(doc: Y.Doc, mutate: () => void): Uint8Array | null {
  const before = Y.encodeStateVector(doc);
  let changed = false;
  const track = (): void => {
    changed = true;
  };
  doc.on("update", track);
  try {
    doc.transact(mutate);
  } finally {
    doc.off("update", track);
  }
  return changed ? Y.encodeStateAsUpdate(doc, before) : null;
}
