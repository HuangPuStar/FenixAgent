import { describe, expect, test } from "bun:test";
import {
  canChangeIssueStateOrAssignee,
  canEditComment,
  canEditTicketContent,
  type TicketAuthority,
} from "../server/services/ticket-permission";

/**
 * 工单域动作权限矩阵（backend contract §2.2 / 方案 §7）。
 *
 * 这一层只吃两个输入：调用方**已判定**的管理员身份，以及**经归属核验**得出的对象作者 ID。因此本文件钉住的
 * 最关键一条是「作者不能伪造」：请求体自填的 `user_id` / `author` 根本不在这里出现——它们进不了 `authorId`，
 * 伪造者只会被判成非创建者。对象归属如何从 `ticket_messages` 核验出来见 `facades.test.ts` 的「作者正确性」
 * 一组；管理员身份的 403 收窄见 `ticket-action-guard.test.ts`。
 *
 * 与端到端的边界：评论/标签 Facade 的 404/403 是**路由与编排级**断言，归 `ticket-comments.test.ts` /
 * `ticket-labels.test.ts`；本文件只覆盖判定本身（判定是那两条路径共同的唯一规则来源）。
 */

describe("工单动作权限矩阵（§2.2）", () => {
  const ADMIN: TicketAuthority = { actorId: "user_admin", isOrganizationAdmin: true };
  const CREATOR: TicketAuthority = { actorId: "user_creator", isOrganizationAdmin: false };
  const ASSIGNEE: TicketAuthority = { actorId: "user_assignee", isOrganizationAdmin: false };
  const STRANGER: TicketAuthority = { actorId: "user_other", isOrganizationAdmin: false };

  // 管理员不受归属限制：他人创建或外部来源（authorId 为 null）都在可改范围，否则无人能修外部工单。
  test("管理员可编辑任何工单的标题与描述", () => {
    expect(canEditTicketContent(ADMIN, { authorId: "user_creator" })).toBe(true);
    expect(canEditTicketContent(ADMIN, { authorId: null })).toBe(true);
  });

  // 创建者对自己创建的工单有内容编辑权：这是「成员可自由维护自己的工单」的最小放行面。
  test("创建者可编辑自己创建的工单", () => {
    expect(canEditTicketContent(CREATOR, { authorId: "user_creator" })).toBe(true);
  });

  // 普通成员改他人工单必须被拒：放开会让任一组织成员静默覆盖别人的标题与描述。
  test("非创建者的普通成员不能编辑他人工单", () => {
    expect(canEditTicketContent(STRANGER, { authorId: "user_creator" })).toBe(false);
  });

  // 外部来源内容只有管理员能动：authorId 为 null 表示归属核验未通过，任何自称作者的说法都不构成授权依据。
  test("外部来源工单只有管理员可编辑，自称作者也不获得权限", () => {
    const forger: TicketAuthority = { actorId: "user_attacker", isOrganizationAdmin: false };
    expect(canEditTicketContent(forger, { authorId: null })).toBe(false);
    expect(canEditTicketContent(STRANGER, { authorId: null })).toBe(false);
    expect(canEditTicketContent(ADMIN, { authorId: null })).toBe(true);
  });

  // 指派、关闭与重开是三态动作：创建者、当前负责人、管理员可做，其他成员被拒。
  test("当前负责人可关闭重开与指派，非创建者非负责人的成员被拒", () => {
    const issue = { authorId: "user_creator", assigneeId: "user_assignee" };
    expect(canChangeIssueStateOrAssignee(CREATOR, issue)).toBe(true);
    expect(canChangeIssueStateOrAssignee(ASSIGNEE, issue)).toBe(true);
    expect(canChangeIssueStateOrAssignee(STRANGER, issue)).toBe(false);
    expect(canChangeIssueStateOrAssignee(ADMIN, issue)).toBe(true);
  });

  // 取消指派即收回权限：负责人身份取当前值，判定不得记住「曾经是负责人」。
  test("取消指派后原负责人失去关闭权限", () => {
    const unassigned = { authorId: "user_creator", assigneeId: null };
    expect(canChangeIssueStateOrAssignee(ASSIGNEE, unassigned)).toBe(false);
    // 创建者不因取消指派而失去权限：两条授权路径彼此独立。
    expect(canChangeIssueStateOrAssignee(CREATOR, unassigned)).toBe(true);
  });

  // 评论编辑只放行原作者与管理员：其它成员（含当前负责人）改他人评论属于篡改他人发言。
  test("评论编辑：原作者与管理员可编辑，其他成员被拒", () => {
    const comment = { authorId: "user_creator" };
    expect(canEditComment(CREATOR, comment)).toBe(true);
    expect(canEditComment(ADMIN, comment)).toBe(true);
    expect(canEditComment(STRANGER, comment)).toBe(false);
    expect(canEditComment(ASSIGNEE, comment)).toBe(false);
  });

  // 归属核验失败的评论（外部来源或缺 ticket_messages 匹配记录）只有管理员可编辑，自填 user_id 不授予编辑权。
  test("归属未核验的评论只有管理员可编辑", () => {
    const forger: TicketAuthority = { actorId: "user_attacker", isOrganizationAdmin: false };
    expect(canEditComment(forger, { authorId: null })).toBe(false);
    expect(canEditComment(ADMIN, { authorId: null })).toBe(true);
  });
});
