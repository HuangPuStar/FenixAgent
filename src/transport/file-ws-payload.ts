import { error as logError } from "@fenix/logger";

/**
 * file-ws 单帧最大载荷（MB），默认 32MB。
 *
 * 与 `src/env.ts` 的 `RCS_FILE_WS_MAX_PAYLOAD_MB` 默认值保持一致：
 * docs/arch/12-files.md §7.6 约定远程 upload 单文件 20MB → base64 帧 ~27MB < 32MB，
 * 使 32MB 恰好覆盖 upload 帧而不过度放宽。
 */
export const DEFAULT_FILE_WS_MAX_PAYLOAD_MB = 32;

/**
 * 估算任意 WS 消息载荷的字节数（检查与日志共用）。
 *
 * - 字符串按 UTF-8 字节（`Buffer.byteLength`），非 ASCII 内容比 `length`（UTF-16 码元）更准确；
 * - 二进制帧按 `byteLength`；
 * - object 帧（Elysia 默认 parse 的产物）重序列化后计字节；
 * - 不可序列化（循环引用等异常路径）返回 `Infinity`，视作超限。
 */
export function estimateWsMessageBytes(data: unknown): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (data instanceof Uint8Array) return data.byteLength;
  if (data !== null && typeof data === "object") {
    try {
      return Buffer.byteLength(JSON.stringify(data));
    } catch {
      return Infinity;
    }
  }
  return 0;
}

/**
 * 解析前的载荷上限检查（D12）：按真实字节数（`Buffer.byteLength`）判断消息是否超限。
 *
 * 必须在 JSON 解析之前调用——file-ws 帧最大可达 ~27MB（20MB upload 的 base64），
 * 若先由 Elysia 自动 `JSON.parse`（`createWSMessageParser` 对 `{` 开头字符串先 parse）
 * 再检查，超大 JSON 帧已全量进内存，10MB 上限形同虚设（§7.6）。
 * 注意：单行 JSON 帧会被 Elysia 默认 parser 提前 parse 成 object，到不了本函数，
 * 由 uWS 层 `maxPayloadLength`（src/index.ts 全局 32MB）兜底；本函数覆盖
 * NDJSON 多行帧（默认 parse 失败保持字符串）与二进制帧。
 *
 * @param message 原始 WS 消息（文本帧为 string；二进制帧为 Uint8Array，按 byteLength 计）
 * @param maxPayloadBytes 载荷上限（字节）
 * @returns 是否超过上限（true = 应拒绝并 close 1009）
 */
export function checkWsMessageSize(message: string | Uint8Array, maxPayloadBytes: number): boolean {
  return estimateWsMessageBytes(message) > maxPayloadBytes;
}

/**
 * 对 Elysia 已自动 parse 的 object 帧补充字节检查。
 *
 * `createWSMessageParser` 对 `{` 开头的字符串会先 `JSON.parse`（无法禁用），
 * 单行 JSON 帧到达自定义 parse / message 回调时已是 object，`typeof === "string"`
 * 检查会被绕过。此函数将 object 重序列化后按字节比较，供 acp-ws / yjs / relay
 * 在 uWS 全局 maxPayloadLength（32MB，W8a 放宽）之下维持各自的 10MB 上限。
 * 正常帧体量小，序列化开销可忽略；不可序列化的异常载荷视为超限。
 *
 * @param data message 回调收到的载荷（object 或非对象）
 * @param maxPayloadBytes 载荷上限（字节）
 * @returns 是否超过上限（true = 应拒绝并 close 1009）
 */
export function checkParsedObjectSize(data: unknown, maxPayloadBytes: number): boolean {
  if (data === null || typeof data !== "object" || data instanceof Uint8Array) return false;
  // 不可序列化（Infinity）必然 > maxPayloadBytes，天然视为超限
  return estimateWsMessageBytes(data) > maxPayloadBytes;
}

/**
 * 解析 file-ws 原始消息（NDJSON：按 `\n` 分行，逐行 `JSON.parse`）。
 *
 * 空行与纯空白行忽略；解析失败的行记录日志后跳过，**不中断**其余行——
 * 机器端一次可能批量发送多条消息，单条坏帧不应丢弃整批。
 * 坏行日志截断至 500 字符：行可达数十 MB（超限帧被拒前仍会走到这里），
 * 整行入日志会造成日志爆炸。
 * 解析成功但非纯对象（`null` / 数组 / 原始值）的行同样跳过：协议只接受
 * `{ type, ... }` 对象帧，`null` 等原始值进入 handler 会在 `msg.type` 访问时
 * 抛 TypeError，违反"坏行不中断整批"的承诺。
 *
 * @param raw 原始文本帧（已被 checkWsMessageSize 放行）
 * @returns 逐行解析出的消息列表
 */
export function parseFileWsMessage(raw: string): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      logError("file-ws parse error:", line.length > 500 ? `${line.slice(0, 500)}... (truncated)` : line);
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      logError("file-ws parse error: 非对象行跳过", line.length > 500 ? `${line.slice(0, 500)}... (truncated)` : line);
      continue;
    }
    messages.push(parsed as Record<string, unknown>);
  }
  return messages;
}
