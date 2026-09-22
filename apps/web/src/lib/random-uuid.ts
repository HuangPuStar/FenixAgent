import { v4 as uuidv4 } from "uuid";

/**
 * 生成浏览器安全的 UUID v4。
 *
 * 原生 `crypto.randomUUID` 仅在 secure context（HTTPS / localhost）下可用，纯 HTTP 部署时其为
 * `undefined`，直接调用会抛 TypeError。全局场景由 `./random-uuid-polyfill` 在 bootstrap 阶段注入
 * 降级实现；此处保留独立降级路径作为纵深防御（polyfill 注入失败或绕过 bootstrap 的调用场景），
 * 保证 HTTP / HTTPS 环境下均可生成随机 ID。
 *
 * 归属说明：本函数原先与一批已迁出功能的旧工具函数同住在 `lib/utils.ts`。那些函数（`esc`、
 * `formatTime`、`statusClass`、`isClosedSessionStatus`、`truncate`、`generateMessageUuid`、
 * `extractEventText`、`isConversationClearedStatus`）的语义已分别由 `@fenix/ui-components/web/chat/*`
 * 与 `@fenix/web-runtime/web/chat/structured-to-thread.ts` 承担，宿主只剩零消费副本，已随之删除；
 * `cn` 则是 `@fenix/ui-components/lib/cn` 的逐字副本，改为直接引用该出口。`randomUUID` 是唯一
 * 仍有生产消费方（`api/fs.ts`、`pages/agent-panel/use-chat-panel-runtime.ts`）的成员，独占一个
 * 意图明确的模块，避免再次变成杂物抽屉。
 */
export function randomUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return uuidv4();
}
