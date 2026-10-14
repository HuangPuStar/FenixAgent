/**
 * 工单身份头：写进 Forgejo 正文的 `aos` YAML 块（生成）与读取时的安全解析（识别、校验、剥离）。
 *
 * 事实源边界：远端正文是**不可信输入**（任何能写仓库的人都能伪造一段 YAML），本模块只负责「识别形状」；
 * 是否授信由 `ticket_messages` 的归属记录与正文摘要共同裁决（读取端核验口径见 backend contract §7.3），
 * 头部自填的作者绝不作为授权依据。因此解析一律 **fail closed**：任何一步不成立都返回 `header = null`，
 * 由调用方按外部来源处理，且**绝不向调用方抛异常**（`reason` 是唯一信号）。
 *
 * 安全口径（逐项对应一处判定）：
 * - **注入自建 YAML 引擎**：gray-matter 的默认 yaml 引擎是它自带的 js-yaml@3 `safeLoad`——会把 `2020-01-01`
 *   解析成 `Date`，且没有深度/别名/大小限制。这里改用 js-yaml@5 并显式指定 `JSON_SCHEMA`：标量收敛到
 *   JSON 类型、自定义标签（`!!js/function` 等）直接报错、重复键报错。传 `options` 还消掉一个副作用：
 *   gray-matter 只在**无 options** 时才启用进程级内容缓存，不可信正文不得进那个缓存。
 * - **头部块 8 KiB 上限，在解析前判定**（`IDENTITY_HEADER_MAX_BYTES`）：先定位块、量字节，再决定是否交给
 *   解析器，避免把超大 YAML 喂进解析器。
 * - **禁别名、限深度**（`assertSafeNode`）：别名是 YAML 的指数展开入口（8 KiB 输入也能炸内存），
 *   而身份头只需要「映射 + 标量」，深度上限取 6（正常头 2–3 层）。
 * - **只认第一个顶层身份头**：正文里再次出现的 `---` 块留在正文里，不参与身份判定。
 *
 * 线格式与领域对象：YAML 用 snake_case 键名（`organization_id` / `message_id` / `ticket.assignee_id`，
 * 与生成样例逐字一致），包内领域对象 `TicketIdentityHeader` 用 camelCase。两者之间只有本文件的一对映射
 * （`toDomainHeader` / `toWireDocument`），别处不得再写第二份，否则改名时会出现「写得进、读不出」的半失效头。
 *
 * 一处**明确偏离** gray-matter 默认行为：文档以 `---` 开头但没有闭合分隔行时，gray-matter 会把整段余文
 * 当成 front matter（正文被吃成空串）。本模块直接判 `missing` 且不调用解析器——未闭合的块不构成身份头，
 * 正文照常展示，也不给「用未闭合块喂解析器」留入口。
 */

import { createHash } from "node:crypto";
import { ValidationError } from "@fenix/platform-sdk";
import matter from "gray-matter";
import {
  dump as dumpYaml,
  eventsToAst,
  JSON_SCHEMA,
  load as loadYaml,
  parseEvents,
  type Node as YamlNode,
} from "js-yaml";
import { TicketIdentityHeaderSchema, type TicketIdentityHeaderWire } from "../../schemas/ticket-identity.schema";
import { MESSAGE_MAX_BYTES } from "./ticket-limits";

/** 身份头 YAML 块的 UTF-8 上限（8 KiB）：超过即 `too_large`，在解析前拒绝。 */
export const IDENTITY_HEADER_MAX_BYTES = 8 * 1024;

/** 身份头的嵌套深度上限：正常头只有 2–3 层，深嵌套只可能是构造出来的载荷。 */
export const IDENTITY_HEADER_MAX_DEPTH = 6;

/** 可信身份头（领域对象）；只有通过 `TicketIdentityHeaderSchema` 的头才会出现在这个类型里。 */
export interface TicketIdentityHeader {
  readonly schema: 1;
  readonly organizationId: string;
  readonly messageId: string;
  readonly author: { readonly id: string; readonly name: string };
  /** T03 起才有负责人；T02 生成时省略。 */
  readonly ticket?: { readonly assigneeId?: string };
}

/** 正文解析结果；`reason` 只在 `header === null` 时有值。 */
export interface ParsedTicketBody {
  /** 剥离身份头后的用户正文；前置失败时退化为「去掉头部块后的剩余文本」。 */
  readonly body: string;
  /** 可信身份头；任何一步失败都是 `null`（调用方按外部来源处理）。 */
  readonly header: TicketIdentityHeader | null;
  readonly reason: "missing" | "too_large" | "invalid_yaml" | "invalid_shape" | null;
}

/**
 * 解析正文：识别并剥离第一个顶层身份头。
 *
 * 判定顺序即失败优先级：无头部块 → `missing`；块超 8 KiB → `too_large`；YAML 解析失败（含深度与别名闸）
 * → `invalid_yaml`；`aos` 缺失 → `missing`；schema 不符 → `invalid_shape`。分档只为可观测性：错误细节
 * 一律不外传、不落日志（正文与解析器堆栈都含不可信内容），`reason` 足以定位。
 */
export function parseTicketBody(raw: string): ParsedTicketBody {
  const normalized = normalizeDocument(raw);
  const block = locateIdentityBlock(normalized);
  if (block === null) return { body: normalized, header: null, reason: "missing" };
  if (Buffer.byteLength(block.headerText, "utf8") > IDENTITY_HEADER_MAX_BYTES) {
    return { body: block.body, header: null, reason: "too_large" };
  }
  const document = parseMatterDocument(normalized);
  if (document === null) return { body: block.body, header: null, reason: "invalid_yaml" };
  const container = isRecord(document.data) ? document.data.aos : undefined;
  if (container === undefined) return { body: document.content, header: null, reason: "missing" };
  const parsed = TicketIdentityHeaderSchema.safeParse(container);
  if (!parsed.success) return { body: document.content, header: null, reason: "invalid_shape" };
  return { body: document.content, header: toDomainHeader(parsed.data), reason: null };
}

/**
 * 生成本包格式的正文：身份头 + 用户正文。
 *
 * 传**文件对象**而不是字符串调用 `matter.stringify`：字符串形态会先被当成文档解析一遍，用户正文若以
 * `---` 开头会被静默吞掉（`matter(file, options)` 分支）。序列化后立刻在**最终字符串**上复核 64 KiB 上限
 * 并做往返自检——引号、换行与 Unicode 的坑必须暴露在写入路径上，而不是等回源解析时才发现（方案 §7）。
 */
export function buildTicketBody(input: { readonly header: TicketIdentityHeader; readonly body: string }): string {
  const serialized = matter.stringify({ content: input.body }, toWireDocument(input.header), {
    language: "yaml",
    engines: YAML_ENGINES,
  });
  if (Buffer.byteLength(serialized, "utf8") > MESSAGE_MAX_BYTES) {
    throw new ValidationError("正文超过 64 KiB 上限");
  }
  const roundTrip = parseTicketBody(serialized);
  if (roundTrip.header === null || roundTrip.header.messageId !== input.header.messageId) {
    throw new Error("身份头序列化往返失败");
  }
  return serialized;
}

/**
 * 正文摘要：`sha256(规范化正文)`；规范化 = 统一 `\n`、`trimEnd`。
 *
 * 归一化让「写入时的输入」与「回源后剥离身份头的内容」得到同一摘要：gray-matter 序列化会补一个尾换行、
 * 解析又会去掉一个前导换行，`trimEnd` 把这层差异抹平。写入路径（§8.3 步骤 7）与读取端核验必须共用本函数。
 */
export function hashBody(rawBody: string): string {
  return createHash("sha256").update(rawBody.replace(/\r\n/g, "\n").trimEnd()).digest("hex");
}

/** 文档级归一化：去 BOM、CRLF → LF。本文件要在解析前自己定位头部块，因此不能只依赖 gray-matter 的归一。 */
function normalizeDocument(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

/**
 * 定位第一个身份头块，返回块文本与剥离后的正文；无块（没有 `---` 起始行或没有闭合行）返回 `null`。
 *
 * 闭合判定与 gray-matter 同源（找首个 `\n---`），保证「量过的字节数」就是喂给解析器的文本；正文起点
 * 额外去掉一个前导换行，与 gray-matter 的 content 口径一致。
 */
function locateIdentityBlock(normalized: string): { headerText: string; body: string } | null {
  if (!normalized.startsWith("---\n")) return null;
  const rest = normalized.slice(3);
  const closeIndex = rest.indexOf("\n---");
  if (closeIndex === -1) return null;
  return {
    headerText: rest.slice(0, closeIndex),
    body: rest.slice(closeIndex + 4).replace(/^\n/, ""),
  };
}

/** 交给 gray-matter 解析（已注入安全引擎）；解析器异常一律折叠成 `null`，调用方只看到 `reason`。 */
function parseMatterDocument(source: string): { data: unknown; content: string } | null {
  try {
    const parsed = matter(source, { language: "yaml", engines: YAML_ENGINES });
    return { data: parsed.data, content: parsed.content };
  } catch {
    return null;
  }
}

/**
 * 注入 gray-matter 的 YAML 引擎。
 *
 * `parse` 的返回值被收窄成 `object`（gray-matter 的类型要求）：非映射文档（标量、序列）折叠成 `{}`——
 * 身份头只存在于映射里，折叠不会误判任何合法头，却让 schema 的输入类型稳定。
 */
const YAML_ENGINES = {
  yaml: {
    parse: (source: string): object => {
      const parsed = safeParseIdentityYaml(source);
      return isRecord(parsed) ? parsed : {};
    },
    stringify: (data: unknown): string => dumpYaml(data, { schema: JSON_SCHEMA, noRefs: true, lineWidth: -1 }),
  },
};

/** 头部 YAML 的安全解析：AST 先过闸（拒别名、限深度），再用 `JSON_SCHEMA` 构造值。 */
function safeParseIdentityYaml(source: string): unknown {
  const documents = eventsToAst(parseEvents(source, {}), { schema: JSON_SCHEMA, source });
  const contents = documents[0]?.contents ?? null;
  if (contents !== null) assertSafeNode(contents, 1);
  return loadYaml(source, { schema: JSON_SCHEMA, json: false });
}

/** 深度上限与别名拒绝：别名是 YAML 的指数展开入口（8 KiB 输入也能炸内存），身份头从不需要它。 */
function assertSafeNode(node: YamlNode, depth: number): void {
  if (depth > IDENTITY_HEADER_MAX_DEPTH) throw new Error("身份头嵌套过深");
  if (node.kind === "alias") throw new Error("身份头不得使用 YAML 别名");
  if (node.kind === "sequence") {
    for (const item of node.items) assertSafeNode(item, depth + 1);
  }
  if (node.kind === "mapping") {
    for (const item of node.items) {
      assertSafeNode(item.key, depth + 1);
      assertSafeNode(item.value, depth + 1);
    }
  }
}

/** 线格式 → 领域对象；与 `toWireDocument` 是唯一一对映射。 */
function toDomainHeader(wire: TicketIdentityHeaderWire): TicketIdentityHeader {
  return {
    schema: wire.schema,
    organizationId: wire.organization_id,
    messageId: wire.message_id,
    author: { id: wire.author.id, name: wire.author.name },
    ...(wire.ticket === undefined ? {} : { ticket: { assigneeId: wire.ticket.assignee_id } }),
  };
}

/** 领域对象 → 线格式（snake_case 键名，键序稳定以便 diff 与人工核对）。 */
function toWireDocument(header: TicketIdentityHeader): Record<string, unknown> {
  return {
    aos: {
      schema: header.schema,
      organization_id: header.organizationId,
      message_id: header.messageId,
      author: { id: header.author.id, name: header.author.name },
      ...(header.ticket === undefined ? {} : { ticket: { assignee_id: header.ticket.assigneeId } }),
    },
  };
}

/** `unknown` 收窄到字符串键映射（数组与 `null` 都不算）——身份头只可能存在于映射里。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
