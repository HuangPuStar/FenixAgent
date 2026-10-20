import { describe, expect, test } from "bun:test";
import { computeCommentVersion, computeContentVersion, normalizeBody } from "../server/services/content-version";
import { buildTicketBody, parseTicketBody, type TicketIdentityHeader } from "../server/services/identity-header";

/**
 * 版本指纹口径（backend contract §4.1 / §4.4）：`expectedVersion` 比较的两端都必须**排除身份头**。
 *
 * 指纹是「把静默覆盖变成 409」的唯一判据，它多算或漏算一个字段都有代价：多算（身份头里的 `message_id`、
 * `assignee_id`）会把一次指派变成版本冲突，让后续编辑持续伪冲突；漏算（正文本体、标签集合）会让过期提交
 * 被当成最新内容写下去。因此这里逐条钉住「什么该变、什么不该变」。
 *
 * 接缝说明：正文一律经 `buildTicketBody` / `parseTicketBody` 往返后再算指纹——直接传裸字符串会绕开
 * 「剥离身份头」这一步，测出来的口径与真实写路径不同。
 */

describe("版本指纹口径（§4.1）", () => {
  const HEADER: TicketIdentityHeader = {
    schema: 1,
    organizationId: "org_alpha",
    messageId: "msg_1",
    author: { id: "user_creator", name: "张三" },
  };

  /** 走真实写路径：序列化身份头 → 回源解析 → 取剥离后的正文。 */
  function visibleBody(body: string, header: TicketIdentityHeader = HEADER): string {
    return parseTicketBody(buildTicketBody({ header, body })).body;
  }

  // 评论指纹只覆盖正文：CRLF 与 LF、尾部空行的差异不是内容差异，否则每次提交都会被判成冲突。
  test("评论指纹只随正文变化且换行写法归一", () => {
    expect(computeCommentVersion("第一行\r\n第二行")).toBe(computeCommentVersion("第一行\n第二行"));
    expect(computeCommentVersion("正文\n")).toBe(computeCommentVersion("正文"));
    expect(computeCommentVersion("正文甲")).not.toBe(computeCommentVersion("正文乙"));
  });

  // 工单与评论的前缀必须不同：共用前缀会让「拿评论正文去比工单版本」这种串味在比较中通过。
  test("工单指纹与评论指纹采用不同前缀", () => {
    const body = "同一段正文";
    expect(computeCommentVersion(body)).not.toBe(
      computeContentVersion({ title: "", body, state: "open", labelNames: [] }),
    );
  });

  // 指派只改身份头里的 assignee_id：正文可见内容未变，指纹必须不变，否则每次指派都会让在途编辑变 409。
  test("工单指纹忽略身份头中的负责人变化", () => {
    const before = visibleBody("正文内容");
    const after = visibleBody("正文内容", { ...HEADER, ticket: { assigneeId: "user_assignee" } });
    // 往返自检：两次的可见正文逐字相同，差别只在身份头。
    expect(after).toBe(before);
    expect(computeContentVersion({ title: "标题", body: after, state: "open", labelNames: ["bug"] })).toBe(
      computeContentVersion({ title: "标题", body: before, state: "open", labelNames: ["bug"] }),
    );
  });

  // 标签是集合：挂载顺序不携带信息（顺序参与指纹会让同一集合的两次提交互相判成过期）。
  test("标签集合顺序不影响工单指纹", () => {
    const base = { title: "标题", body: "正文", state: "open" as const };
    expect(computeContentVersion({ ...base, labelNames: ["bug", "ui"] })).toBe(
      computeContentVersion({ ...base, labelNames: ["ui", "bug"] }),
    );
    // 集合内容变化必须换指纹：漏算会让改标签的并发提交静默覆盖对方的标签集合。
    expect(computeContentVersion({ ...base, labelNames: ["bug"] })).not.toBe(
      computeContentVersion({ ...base, labelNames: ["bug", "ui"] }),
    );
  });

  // 关闭/重开必须换指纹：状态参与比较才能让「基于 open 版本提交的关闭」在他人已关闭时被判为过期。
  test("状态参与工单指纹", () => {
    const base = { title: "标题", body: "正文", labelNames: [] as readonly string[] };
    expect(computeContentVersion({ ...base, state: "open" })).not.toBe(
      computeContentVersion({ ...base, state: "closed" }),
    );
  });

  // 归一化函数是写入与核对两端共用的口径：它只做 CRLF 与尾部空白，不得改写正文内容本身。
  test("正文归一化只处理换行与尾部空白", () => {
    expect(normalizeBody("a\r\nb\r\n")).toBe("a\nb");
    expect(normalizeBody("  前导空格保留")).toBe("  前导空格保留");
    expect(normalizeBody("正文")).toBe("正文");
  });
});
