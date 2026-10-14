import { describe, expect, test } from "bun:test";
import { type GitError, isGitError } from "../contracts/errors";
import type { RepositoryRef } from "../contracts/types";
import { toGitActor, toGitComment, toGitIssue, toGitLabel, toGitRepository } from "../forgejo/mapper";

/**
 * DTO → 领域类型的转换契约测试（方案 §5）。
 *
 * mapper 是适配器的**防腐边界**：跨出它的值必须已满足 `contracts/types.ts` 的形状，因此用例锁定三类
 * 行为——必需字段缺失或类型不符必须报 `INVALID_RESPONSE`（猜一个值比报错危险）、可选字段缺失取安全默认
 * 但「存在却类型不符」仍拒绝、以及所有数字 ID 一律字符串化（int64 超过 2^53 后退化成 number 会静默丢精度）。
 *
 * 同时断言错误消息只带字段名：上游正文可能包含用户内容，不得进入错误消息与日志。
 */

const REF: RepositoryRef = { connectionId: "primary", providerRepositoryId: "7", owner: "acme", name: "demo" };

/** 断言转换以 GitError 失败并返回它，便于继续断言错误码与消息。 */
function gitErrorOf(work: () => unknown): GitError {
  try {
    work();
  } catch (error) {
    if (isGitError(error)) return error;
    throw error;
  }
  throw new Error("期望转换失败，但它成功了");
}

/** 合法 Issue DTO；用例只覆盖需要变化的字段。 */
function issueDto(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 12,
    title: "登录失败",
    body: "复现步骤",
    state: "open",
    labels: [{ id: 3, name: "bug", color: "ff0000", description: "缺陷" }],
    user: { id: 1, login: "alice" },
    assignee: { id: 2, login: "bob" },
    updated_at: "2024-01-02T03:04:05Z",
    ...overrides,
  };
}

function repositoryDto(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    name: "demo",
    owner: { id: 1, login: "acme" },
    private: true,
    has_issues: true,
    default_branch: "main",
    description: "示例仓库",
    ...overrides,
  };
}

describe("操作者与标签", () => {
  // 操作者身份取自数字 id 与 login：id 必须字符串化，login 必须存在（缺了无法展示也无法核对归属）。
  test("maps a user DTO to an actor with a stringified id", () => {
    expect(toGitActor({ id: 42, login: "alice" })).toEqual({ id: "42", name: "alice" });
  });

  // 缺 login、非整数 id 或整体不是对象 → INVALID_RESPONSE：身份字段不能靠默认值顶替。
  test("rejects an actor DTO without a usable identity", () => {
    for (const dto of [undefined, null, "alice", { id: 1 }, { login: "alice" }, { id: 1.5, login: "alice" }]) {
      expect(gitErrorOf(() => toGitActor(dto)).code).toBe("INVALID_RESPONSE");
    }
  });

  // 标签 id 字符串化；颜色与描述允许为空（Forgejo 原生字段可为 null 或空串），统一归一为 null。
  test("maps a label DTO and normalizes empty optional fields to null", () => {
    expect(toGitLabel({ id: 3, name: "bug", color: "ff0000", description: "缺陷" })).toEqual({
      id: "3",
      name: "bug",
      color: "ff0000",
      description: "缺陷",
    });
    expect(toGitLabel({ id: "3", name: "bug", color: "", description: null })).toEqual({
      id: "3",
      name: "bug",
      color: null,
      description: null,
    });
  });

  // 标签的可选字段「存在却类型不符」仍拒绝：默认值只用于上游没给，不用于上游给错了。
  test("rejects a label DTO whose optional fields have the wrong type", () => {
    expect(gitErrorOf(() => toGitLabel({ id: 3, name: "bug", color: 17 })).code).toBe("INVALID_RESPONSE");
    expect(gitErrorOf(() => toGitLabel({ id: 3, name: "bug", description: { text: "x" } })).code).toBe(
      "INVALID_RESPONSE",
    );
  });
});

describe("Issue 投影", () => {
  // 完整 DTO 映射为领域 Issue：数字 ID 字符串化、标签集合逐个转换、负责人与更新时间一并投影。
  test("maps a full issue DTO to the domain shape", () => {
    expect(toGitIssue(issueDto())).toEqual({
      number: "12",
      title: "登录失败",
      body: "复现步骤",
      state: "open",
      labels: [{ id: "3", name: "bug", color: "ff0000", description: "缺陷" }],
      author: { id: "1", name: "alice" },
      assignee: { id: "2", name: "bob" },
      providerUpdatedAt: "2024-01-02T03:04:05.000Z",
    });
  });

  // assignee 为空即为 null；assignees 数组只用于创建时传参，不参与投影（否则会猜错唯一负责人）。
  test("projects an unassigned issue as null and ignores the assignees array", () => {
    const issue = toGitIssue(issueDto({ assignee: null, assignees: [{ id: 2, login: "bob" }] }));

    expect(issue.assignee).toBeNull();
  });

  // 缺 title 或缺 user → INVALID_RESPONSE，消息只带字段名，不回显正文内容。
  test("rejects an issue DTO missing identity fields without echoing the body", () => {
    const { title: _title, ...withoutTitle } = issueDto();
    const missingTitle = gitErrorOf(() => toGitIssue(withoutTitle));
    expect(missingTitle.code).toBe("INVALID_RESPONSE");
    expect(missingTitle.message).toContain("issue.title");
    expect(missingTitle.message).not.toContain("复现步骤");

    const { user: _user, ...withoutUser } = issueDto();
    expect(gitErrorOf(() => toGitIssue(withoutUser)).code).toBe("INVALID_RESPONSE");
  });

  // 正文缺失或为 null 按空正文处理；state 只可能是 open/closed，其它取值一律拒绝。
  test("defaults a missing body to empty and rejects an unknown state", () => {
    expect(toGitIssue(issueDto({ body: null })).body).toBe("");
    expect(toGitIssue(issueDto({ body: undefined })).body).toBe("");

    expect(gitErrorOf(() => toGitIssue(issueDto({ state: "merged" }))).code).toBe("INVALID_RESPONSE");
  });

  // labels 存在但不是数组 → INVALID_RESPONSE：静默丢弃标签会让调用方以为标签被清空了。
  test("rejects a labels field that is not an array", () => {
    expect(gitErrorOf(() => toGitIssue(issueDto({ labels: "bug" }))).code).toBe("INVALID_RESPONSE");

    expect(toGitIssue(issueDto({ labels: null })).labels).toEqual([]);
  });

  // providerUpdatedAt 归一为 ISO 字符串，非法或缺失取 null：该字段只作同步参考，不臆造时间。
  test("normalizes providerUpdatedAt to ISO and falls back to null", () => {
    expect(toGitIssue(issueDto({ updated_at: "2024-01-02" })).providerUpdatedAt).toBe("2024-01-02T00:00:00.000Z");
    expect(toGitIssue(issueDto({ updated_at: "not-a-date" })).providerUpdatedAt).toBeNull();
    expect(toGitIssue(issueDto({ updated_at: 1704164645 })).providerUpdatedAt).toBeNull();
    expect(toGitIssue(issueDto({ updated_at: undefined })).providerUpdatedAt).toBeNull();
  });

  // 数字 ID 以字符串承载：int64 超出 2^53 后 number 会丢精度，字符串形态必须原样保留。
  test("keeps large identifiers exact by carrying them as strings", () => {
    expect(toGitIssue(issueDto({ number: "9223372036854775807" })).number).toBe("9223372036854775807");
    expect(toGitIssue(issueDto({ number: 9007199254740991 })).number).toBe("9007199254740991");
  });
});

describe("仓库投影", () => {
  // 传入 ref 时它是权威坐标（来自绑定记录），DTO 的身份字段不参与寻址，只补齐展示字段。
  test("prefers the bound ref over the response identity", () => {
    const repository = toGitRepository(REF, repositoryDto({ id: 999, name: "other", owner: { login: "someone" } }));

    expect(repository.ref).toEqual(REF);
    expect(repository.isPrivate).toBe(true);
    expect(repository.issuesEnabled).toBe(true);
    expect(repository.defaultBranch).toBe("main");
    expect(repository.description).toBe("示例仓库");
  });

  // 缺 has_issues 按未开启处理：上层据此走「确保开启」的自愈路径，而不是让整次读取失败。
  test("treats a missing has_issues flag as disabled", () => {
    const repository = toGitRepository(REF, repositoryDto({ has_issues: undefined, description: "" }));

    expect(repository.issuesEnabled).toBe(false);
    expect(repository.description).toBeNull();
  });

  // ref 为 null（建仓场景）时坐标只能取自响应，connectionId 留空串由组合根补齐——这是可见的欠账，不是默认值。
  test("derives the ref from the response and leaves connectionId empty when no ref is bound", () => {
    const repository = toGitRepository(null, repositoryDto());

    expect(repository.ref).toEqual({ connectionId: "", providerRepositoryId: "7", owner: "acme", name: "demo" });
  });

  // 无 ref 且响应缺少 owner/name/id → INVALID_RESPONSE：缺了坐标就无法寻址，不能猜。
  test("rejects a repository DTO without coordinates when no ref is bound", () => {
    for (const dto of [repositoryDto({ owner: undefined }), repositoryDto({ name: "" }), repositoryDto({ id: null })]) {
      expect(gitErrorOf(() => toGitRepository(null, dto)).code).toBe("INVALID_RESPONSE");
    }
  });
});

describe("评论投影", () => {
  // 列表与创建路径已知工单编号，直接采用；评论 id 同样字符串化。
  test("uses the caller supplied issue number when it is known", () => {
    const comment = toGitComment(
      { id: 55, body: "已修复", user: { id: 1, login: "alice" }, updated_at: "2024-03-04T05:06:07Z" },
      "12",
    );

    expect(comment).toEqual({
      id: "55",
      issueNumber: "12",
      body: "已修复",
      author: { id: "1", name: "alice" },
      providerUpdatedAt: "2024-03-04T05:06:07.000Z",
    });
  });

  // 编辑评论端点路径不含工单编号，只能从 issue_url 末段取；两处都拿不到就拒绝，绝不猜编号（评论会挂错工单）。
  test("reads the issue number from issue_url and refuses to guess it", () => {
    const fromUrl = toGitComment({
      id: 55,
      body: "已修复",
      user: { id: 1, login: "alice" },
      issue_url: "http://forgejo.test:3210/api/v1/repos/acme/demo/issues/12",
    });
    expect(fromUrl.issueNumber).toBe("12");

    const error = gitErrorOf(() => toGitComment({ id: 55, body: "已修复", user: { id: 1, login: "alice" } }));
    expect(error.code).toBe("INVALID_RESPONSE");
    expect(error.message).toContain("issue_url");
  });
});
