/**
 * Chat UI 体系的结构类型契约（phase1 产出，phase2 各组只读、不得修改）。
 *
 * 本文件是包内 Chat 类型的唯一导入面：消费方一律 `import type { ... } from "../types"`，
 * 不直接引用 `internal/` 下的实现文件。类型全部由源实现逐字复制，字段名保持一致，
 * 宿主可零适配直接传值。
 *
 * 来源：
 * - `apps/web/src/lib/types.ts`（旧路径，已于 2026-09-21 由 6679b4648 删除）（统一 Chat 数据模型）、`apps/web/src/lib/tool-semantic.ts`（旧路径，已于 2026-09-21 由 6679b4648 删除）、
 *   `apps/web/src/lib/extract-changed-files.ts`（旧路径，已于 2026-09-21 由 6679b4648 删除）
 * - `@fenix/chat-channel` 公开类型（`src/types.ts` / `src/schema.ts` / `src/public-error.ts`）
 * - `packages/acp-link/src/types.ts` 的协议块类型（经 chat-channel 转导后为 Chat UI 消费面）
 *
 * 纯化改动点：
 * - 不 import 任何 `@fenix/*` 依赖（含 `import type`），被引用的外部类型全部在包内内联。
 * - 源 `ToolCallData.semantic` 引用的 `./tool-semantic` 的 `ToolSemantic` 一并内联（纯类型）。
 * - chat-channel 自带块类型 `ToolCallContentBlock` 与 acp-link 协议同名，包内重命名为
 *   `StructuredToolCallContentBlock`（其余类型名与源一致）。
 *
 * 拆分说明：实现按来源与职责拆到 `internal/types-{acp-protocol,chat-model,chat-projection}.ts`，
 * 原因是单个类型文件超过 500 行红线；本文件只做 re-export，导出面与拆分前完全一致。
 * 缺类型时在报告中登记类型名与字段，由集成阶段统一补齐，不要在本文件就地扩写。
 */

export type * from "./internal/types-acp-protocol";
export type * from "./internal/types-chat-model";
export type * from "./internal/types-chat-projection";
