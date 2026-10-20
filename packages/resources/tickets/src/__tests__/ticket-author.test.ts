import { describe, expect, test } from "bun:test";
import type { TicketMessageRow } from "../server/repositories/ticket-messages";
import {
  buildTicketBody,
  hashBody,
  parseTicketBody,
  type TicketIdentityHeader,
} from "../server/services/identity-header";
import { resolveTicketAuthor } from "../server/services/ticket-author";

/**
 * 作者归属核验的**拒绝面**（backend contract §3.1 / §3.2）：对不上号一律 `external`。
 *
 * 为什么单独成文件：T03 的评论列表与单条评论都复用本函数（评论归属行与工单归属行靠 `object_kind` 天然隔离），
 * 而「对不上号」的几种形态决定了评论编辑权限的边界——**任何**一种漏判都会让自填身份获得编辑权。本文件因此
 * 穷举拒绝路径：缺归属行、对象 ID 不符、组织不符、摘要不符（`facades.test.ts` 已覆盖摘要与 `message_id`
 * 两种经 Facade 的形态，这里补的是前三种在函数层的判定）。
 *
 * 接缝说明：不注入任何替身——本函数是纯函数，只吃「远端正文 + 本端归属行」，正文经真实
 * `buildTicketBody` 序列化，避免用字符串拼接模拟出真实写路径里不存在的形状。
 */

describe("作者归属核验（§3.1）", () => {
  const ORG_A = "org_alpha";
  const ORG_B = "org_beta";
  /** 头部自填的作者指向另一个 AOS 用户：核验通过时也只能采信归属行，核验不通过时更是如此。 */
  const HEADER: TicketIdentityHeader = {
    schema: 1,
    organizationId: ORG_A,
    messageId: "msg_1",
    author: { id: "user_claimed", name: "自称的作者" },
  };

  const EXTERNAL_ACTOR = { id: "bot-ext", name: "外部账号" };
  const RAW_BODY = buildTicketBody({ header: HEADER, body: "评论正文" });

  function messageRow(overrides: Partial<TicketMessageRow> = {}): TicketMessageRow {
    return {
      id: "message-1",
      projectId: "project-1",
      objectKind: "comment",
      providerObjectId: "comment-1",
      messageId: HEADER.messageId,
      authorId: "user_owner",
      authorNameSnapshot: "写入时的名字",
      bodyHash: hashBody(parseTicketBody(RAW_BODY).body),
      revision: 1,
      lastEditorId: null,
      createdAt: new Date("2026-10-12T08:00:00.000Z"),
      updatedAt: new Date("2026-10-12T08:00:00.000Z"),
      ...overrides,
    };
  }

  /** 统一的调用形状：默认是「一切吻合」的基线，各用例只改一处让它对不上号。 */
  function resolve(overrides: Partial<Parameters<typeof resolveTicketAuthor>[0]> = {}) {
    return resolveTicketAuthor({
      organizationId: ORG_A,
      providerObjectId: "comment-1",
      rawBody: RAW_BODY,
      fallbackActor: EXTERNAL_ACTOR,
      message: messageRow(),
      ...overrides,
    });
  }

  // 缺归属行即来源不明：没有本端记录可对齐时，正文里的自填身份（含 user_id）完全不可信。
  test("缺归属记录时判为外部来源且不采信自填身份", () => {
    const resolution = resolve({ message: undefined });

    expect(resolution).toEqual({ source: "external", authorId: null, authorName: EXTERNAL_ACTOR.name });
  });

  // 对象 ID 必须与归属行的对象一致：否则任意一条 AOS 归属行都能替别处的正文背书（跨对象冒名）。
  test("对象 ID 与归属记录不符时判为外部来源", () => {
    const resolution = resolve({ providerObjectId: "comment-2" });

    expect(resolution.source).toBe("external");
    expect(resolution.authorId).toBeNull();
  });

  // 跨组织搬运的正文不得继承作者：组织是归属行的一部分，头部的组织字段只是「待核对的声明」。
  test("组织与归属记录不符时判为外部来源", () => {
    const resolution = resolve({ organizationId: ORG_B });

    expect(resolution.source).toBe("external");
    expect(resolution.authorId).toBeNull();
  });

  // 摘要不符表示正文在 AOS 写入之后被改过（或归属行没跟上）：当下内容不能再归给原作者。
  test("正文摘要与归属记录不符时判为外部来源", () => {
    const tampered = buildTicketBody({ header: HEADER, body: "被改过的正文" });
    const resolution = resolve({ rawBody: tampered });

    expect(resolution.source).toBe("external");
    expect(resolution.authorId).toBeNull();
  });

  // 无身份头的正文（外部直接在托管平台创建）同样是外部来源：识别不到头就没有可对齐的坐标。
  test("正文没有身份头时判为外部来源", () => {
    const resolution = resolve({ rawBody: "直接在托管平台写的评论" });

    expect(resolution).toEqual({ source: "external", authorId: null, authorName: EXTERNAL_ACTOR.name });
  });

  // 全部吻合才判 AOS：作者 ID 与展示名取归属记录（头部自填的 author 只用于对齐，不参与授权）。
  test("身份头与归属记录吻合时采信归属行的作者", () => {
    const resolution = resolve();

    expect(resolution).toEqual({
      source: "aos",
      authorId: "user_owner",
      authorName: "写入时的名字",
      messageId: HEADER.messageId,
    });
  });
});
