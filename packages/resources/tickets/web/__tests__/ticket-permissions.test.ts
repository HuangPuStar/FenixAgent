// web/__tests__/ticket-permissions.test.ts
// 评论「编辑」入口的可见性契约（前端合同 §4.5，裁定三.17）。纯逻辑：不 import React、不读 i18n、不发请求，
// 因此不需要渲染环境。
//
// 为什么这四条边界必须逐条钉住：入口多显示一次，用户就会走一次注定 403 的往返（服务端才是判定点）；
// 少显示一次，作者就改不了自己的评论。四个方向里有两个是「null 相等」的陷阱——外部来源的作者 id 恒为
// null、会话未就绪时 userId 也是 null，任一处漏判都会把「双方都是 null」读成「本人」。

import { describe, expect, test } from "bun:test";

import type { TicketComment } from "../api/ticket-comments";
import type { TicketActor } from "../api/tickets";
import { canEditComment } from "../lib/ticket-permissions";

/** 评论夹具：只有作者投影与业务判定相关，其余字段给足让类型成立。 */
function comment(author: TicketActor): TicketComment {
  return {
    commentId: "9001",
    issueNumber: "42",
    body: "复现步骤：点击登录后页面空白。",
    author,
    version: "v1",
    providerUpdatedAt: "2026-10-12T09:00:00.000Z",
  };
}

describe("评论编辑入口可见性 canEditComment", () => {
  // 唯一应当显示入口的情形：作者归属经账本核验通过，且正是当前登录用户。
  test("作者本人且归属核验通过时显示编辑入口", () => {
    expect(canEditComment(comment({ id: "user-1", name: "张三", source: "aos" }), { userId: "user-1" })).toBe(true);
  });

  // 组织里的其他成员同样是「他人」：界面少给一个按钮，就不会把用户引向一次必然失败的写入。
  test("他人的评论不显示编辑入口", () => {
    expect(canEditComment(comment({ id: "user-2", name: "李四", source: "aos" }), { userId: "user-1" })).toBe(false);
  });

  // 外部来源的评论不属于任何本地账号（id 恒为 null）：它不是「像本人」，而是「无法归属」。
  // 若判定只比 id，`null === null` 会让任何会话拿到别人的评论编辑入口。
  test("外部来源评论的作者 id 为 null 时判否", () => {
    expect(canEditComment(comment({ id: null, name: "路人甲", source: "external" }), { userId: "user-1" })).toBe(false);
  });

  // 反向的同一个陷阱：会话未就绪（投影 pending）时 userId 为 null，与外部作者 id 相等——必须仍判否。
  test("会话未就绪（userId 为 null）时判否，即使作者 id 也是 null", () => {
    expect(canEditComment(comment({ id: null, name: "路人甲", source: "external" }), { userId: null })).toBe(false);
    expect(canEditComment(comment({ id: "user-1", name: "张三", source: "aos" }), { userId: null })).toBe(false);
  });

  // 归属核验未通过（source 为 external）时 id 本该为 null；即便后端将来回带一个 id，
  // 也只按「未经核验」处理——不把来路不明的身份当成可授权的主体。
  test("来源为 external 时即使带 id 也不判为本人", () => {
    expect(canEditComment(comment({ id: "user-1", name: "张三", source: "external" }), { userId: "user-1" })).toBe(
      false,
    );
  });
});
