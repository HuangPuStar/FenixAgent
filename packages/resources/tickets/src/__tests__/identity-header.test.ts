import { describe, expect, test } from "bun:test";
import { ValidationError } from "@fenix/platform-sdk";
import {
  buildTicketBody,
  hashBody,
  IDENTITY_HEADER_MAX_BYTES,
  parseTicketBody,
  type TicketIdentityHeader,
} from "../server/services/identity-header";
import { MESSAGE_MAX_BYTES } from "../server/services/ticket-limits";

const HEADER: TicketIdentityHeader = {
  schema: 1,
  organizationId: "org_123",
  messageId: "msg_01H",
  author: { id: "user_456", name: "张三" },
};

describe("identity header", () => {
  // 生成的身份头必须能被自身解析回同值（中文显示名与多行正文的引号、换行处理在两侧一致）
  test("round-trips a generated header", () => {
    const body = "部署完成后无法打开预览页面。\n\n第二段";
    const parsed = parseTicketBody(buildTicketBody({ header: HEADER, body }));

    expect(parsed.reason).toBeNull();
    expect(parsed.header).toEqual(HEADER);
    expect(parsed.body.trimEnd()).toBe(body);
  });

  // 生成的 YAML 走 snake_case 线格式（键名即对外协议，改名会让回源解析识别不出旧头）
  test("serializes the header in the wire format", () => {
    const serialized = buildTicketBody({ header: HEADER, body: "正文" });

    expect(serialized.startsWith("---\naos:\n  schema: 1\n  organization_id: org_123\n  message_id: msg_01H\n")).toBe(
      true,
    );
    expect(serialized).toContain("name: 张三");
    expect(serialized).toContain("\n---\n正文\n");
  });

  // T03 的负责人字段在线格式中是 `ticket.assignee_id`，可选映射必须在往返中稳定
  test("round-trips the optional assignee field", () => {
    const header: TicketIdentityHeader = { ...HEADER, ticket: { assigneeId: "user_789" } };
    const parsed = parseTicketBody(buildTicketBody({ header, body: "正文" }));

    expect(parsed.header).toEqual(header);
  });

  // 没有身份头的正文是普通外部内容：header 为 null、正文原样保留
  test("treats a body without a header as missing", () => {
    const raw = "部署完成后无法打开预览页面。\n\n---\n这段 YAML 出现在正文里";
    const parsed = parseTicketBody(raw);

    expect(parsed.header).toBeNull();
    expect(parsed.reason).toBe("missing");
    expect(parsed.body).toBe(raw);
  });

  // 头部块超过 8 KiB 时必须在解析前拒绝：块里同时放了自定义标签，只有命中 too_large 才说明大小闸先于 YAML 解析
  test("rejects an oversized header block before parsing", () => {
    const padding = "x".repeat(IDENTITY_HEADER_MAX_BYTES + 1);
    const raw = `---\naos:\n  schema: 1\n  padding: !!js/function "${padding}"\n---\n正文`;
    const parsed = parseTicketBody(raw);

    expect(parsed.reason).toBe("too_large");
    expect(parsed.header).toBeNull();
    expect(parsed.body).toBe("正文");
  });

  // 嵌套超过深度上限（第 7 层）必须拒绝，且判成解析失败而不是形状失败
  test("rejects a header nested beyond the depth limit", () => {
    const raw = `---\naos:\n  schema: 1\n  extra:\n    a:\n      b:\n        c:\n          d:\n            e:\n              f: 1\n---\n正文`;
    const parsed = parseTicketBody(raw);

    expect(parsed.reason).toBe("invalid_yaml");
    expect(parsed.header).toBeNull();
  });

  // YAML 别名是「指数展开」的入口：这里的 name 借用别名的值与合法头形状等价，仍必须被拒
  test("rejects YAML aliases", () => {
    const raw = `---\naos:\n  schema: 1\n  organization_id: &anchor "org_123"\n  message_id: "msg_01H"\n  author:\n    id: "user_456"\n    name: *anchor\n---\n正文`;
    const parsed = parseTicketBody(raw);

    expect(parsed.reason).toBe("invalid_yaml");
    expect(parsed.header).toBeNull();
  });

  // 自定义 YAML 标签（`!!js/function` 等）不得被求值：JSON_SCHEMA 直接报错
  test("rejects custom YAML tags", () => {
    const raw = `---\naos:\n  schema: 1\n  organization_id: "org_123"\n  message_id: !!js/function "function(){}"\n  author:\n    id: "user_456"\n    name: "张三"\n---\n正文`;
    const parsed = parseTicketBody(raw);

    expect(parsed.reason).toBe("invalid_yaml");
    expect(parsed.header).toBeNull();
  });

  // 重复键必须报错而不是「后者覆盖前者」：重复键会让「服务端写的头」与「解析器读到的头」不一致
  test("rejects duplicated mapping keys", () => {
    const raw = `---\naos:\n  schema: 1\n  message_id: "msg_attacker"\n  message_id: "msg_01H"\n---\n正文`;
    const parsed = parseTicketBody(raw);

    expect(parsed.reason).toBe("invalid_yaml");
    expect(parsed.header).toBeNull();
  });

  // 只认第一个顶层身份头：正文里再次出现的 YAML 块不参与身份判定，且原样留在正文中
  test("ignores a second YAML block inside the body", () => {
    const raw = `---\naos:\n  schema: 1\n  organization_id: "org_123"\n  message_id: "msg_first"\n  author:\n    id: "user_456"\n    name: "张三"\n---\n---\naos:\n  schema: 1\n  organization_id: "org_evil"\n  message_id: "msg_second"\n  author:\n    id: "attacker"\n    name: "外部"\n---\n正文`;
    const parsed = parseTicketBody(raw);

    expect(parsed.reason).toBeNull();
    expect(parsed.header?.messageId).toBe("msg_first");
    expect(parsed.header?.organizationId).toBe("org_123");
    expect(parsed.body).toContain("msg_second");
  });

  // `author.id` 类型不符判 invalid_shape 而不是抛异常：远端正文不可信，解析器不得把故障升级成 500
  test("reports invalid_shape for a non-string author id", () => {
    const raw = `---\naos:\n  schema: 1\n  organization_id: "org_123"\n  message_id: "msg_01H"\n  author:\n    id: 456\n    name: "张三"\n---\n正文`;
    const parsed = parseTicketBody(raw);

    expect(parsed.reason).toBe("invalid_shape");
    expect(parsed.header).toBeNull();
  });

  // 未知键一律拒绝（fail closed）：头只由本服务生成，多出字段说明有别的写入者，不能按自填值授信
  test("rejects unknown header keys", () => {
    const raw = `---\naos:\n  schema: 1\n  organization_id: "org_123"\n  message_id: "msg_01H"\n  author:\n    id: "user_456"\n    name: "张三"\n  author_id: "user_forged"\n---\n正文`;
    const parsed = parseTicketBody(raw);

    expect(parsed.reason).toBe("invalid_shape");
    expect(parsed.header).toBeNull();
  });

  // 正文以 `---` 开头时不得被当作 front matter 吞掉（stringify 必须走文件对象形态）
  test("keeps a body that starts with a delimiter", () => {
    const body = "---\nfoo: 1\n---\n尾部";
    const parsed = parseTicketBody(buildTicketBody({ header: HEADER, body }));

    expect(parsed.reason).toBeNull();
    expect(parsed.body.trimEnd()).toBe(body);
  });

  // 未闭合的 `---` 文档按「没有身份头」处理：不把整段余文交给 YAML 解析器（否则正文会被吃成空串）
  test("treats an unclosed delimiter document as external content", () => {
    const raw = "---\naos:\n  schema: 1";
    const parsed = parseTicketBody(raw);

    expect(parsed.reason).toBe("missing");
    expect(parsed.header).toBeNull();
    expect(parsed.body).toBe(raw);
  });

  // 序列化后的整串超过 64 KiB 必须抛 ValidationError（在最终字符串上量字节，而不是用户输入的字符数）
  test("rejects a serialized body above the message limit", () => {
    const body = "a".repeat(MESSAGE_MAX_BYTES);

    expect(() => buildTicketBody({ header: HEADER, body })).toThrow(ValidationError);
  });

  // 正文摘要跨换行风格稳定：CRLF 与 LF、尾部空白得到同一摘要（写入与读取端共用同一口径）
  test("normalizes line endings and trailing whitespace in body hashes", () => {
    expect(hashBody("第一行\r\n第二行\r\n")).toBe(hashBody("第一行\n第二行"));
    expect(hashBody("第一行\n第二行")).toHaveLength(64);
  });
});
