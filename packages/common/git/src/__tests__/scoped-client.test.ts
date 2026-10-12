import { describe, expect, test } from "bun:test";
import { GitError } from "../contracts/errors";
import { ForgejoClient } from "../forgejo/client";
import type { FetchLike } from "../forgejo/http";
import type { GitConnectionConfig } from "../server/config";
import type { GitBindingRecord } from "../server/repositories/bindings";
import { createScopedClientFromBinding } from "../server/scoped-client";

/**
 * 作用域客户端的授权与透传契约（方案 §5、实施合同 §5.1）。
 *
 * 这一层是**消费者唯一能拿到的入口**，因此用例锁定的不是「正常调用能跑通」，而是两条边界：
 * 1. 拒绝只发生在授权判定里，且必须发生在**任何出站请求之前**——拒绝后仍打了一次 Forgejo，等于把
 *    「无权」变成「有权但上游失败」；
 * 2. 授权通过时，坐标与操作必须原样落到适配器上（operation → HTTP 方法/路径的映射），映射错一位就会
 *    出现「读操作改了远端」这类静默事故。
 *
 * 适配器用真实 `ForgejoClient` + 注入的 `fetchImpl` 替身：替身记录每次请求，用例断言 URL、方法与凭据头，
 * 全程不触网、也不替换 `globalThis.fetch`（同批 `bun test` 下全局替身会跨文件生效）。
 */

const CONNECTION: GitConnectionConfig = {
  id: "primary",
  baseUrl: "http://forgejo.test:3210",
  provisionToken: "provision-token-value",
  requestTimeoutMs: 15_000,
  maxConcurrentRequests: 16,
};

/** 合成日常凭据：只用于断言请求头形态，不指向任何真实实例。 */
const SERVICE_TOKEN = "service-token-value";

const REPOSITORY_URL = `${CONNECTION.baseUrl}/api/v1/repos/acme/demo`;

/** 绑定记录的字段是可读的，但用例需要模拟「创建后被暂停/收回授权」，故用可变投影构造夹具。 */
type MutableBinding = { -readonly [K in keyof GitBindingRecord]: GitBindingRecord[K] };

function bindingOf(overrides: Partial<GitBindingRecord> = {}): MutableBinding {
  return {
    id: "binding-1",
    organizationId: "org-1",
    connectionId: CONNECTION.id,
    providerRepositoryId: "42",
    owner: "acme",
    name: "demo",
    credentialRef: "{env:AOS_GIT_SERVICE_TOKEN}",
    allowedConsumers: { tickets: ["issues.read"] },
    webhookId: null,
    webhookSecretRef: null,
    status: "active",
    ...overrides,
  };
}

/** 合法的最小 Forgejo 响应体：工单与仓库的必需字段齐备（字段级校验已由适配器用例覆盖）。 */
const ISSUE_DTO = {
  number: 7,
  title: "工单标题",
  state: "open",
  user: { id: 11, login: "alice" },
};

const REPOSITORY_DTO = {
  id: 42,
  name: "demo",
  owner: { login: "acme" },
  private: true,
  has_issues: true,
  default_branch: "main",
};

interface StubCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/**
 * 注入式传输替身：按调用顺序返回预置响应。
 *
 * 预置响应用完后的请求直接失败而不是返回 undefined —— 多打一次请求（例如拒绝路径漏过了判定）必须让
 * 用例当场变红，而不是被后续断言掩盖。
 */
function createFetchStub(responses: readonly unknown[]): { calls: StubCall[]; fetchImpl: FetchLike } {
  const calls: StubCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: input, init });
    const body = responses[calls.length - 1];
    if (body === undefined) throw new Error(`未预期的第 ${calls.length} 次请求：${init?.method ?? "GET"} ${input}`);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

function headersOf(call: StubCall): Readonly<Record<string, string>> {
  const headers = call.init?.headers;
  if (headers === undefined) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

function scopedFor(binding: GitBindingRecord, consumerId: string, fetchImpl: FetchLike) {
  return createScopedClientFromBinding({
    binding,
    connection: CONNECTION,
    consumerId,
    serviceToken: SERVICE_TOKEN,
    client: new ForgejoClient({
      baseUrl: CONNECTION.baseUrl,
      token: SERVICE_TOKEN,
      fetchImpl,
    }),
  });
}

/** 断言操作被拒为 `FORBIDDEN`；失败时给出比 `rejects.toThrow` 更明确的诊断。 */
async function expectForbidden(action: () => Promise<unknown>, messagePart: string): Promise<GitError> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toContain(messagePart);
    return error;
  }
  throw new Error("期望操作被拒绝，但成功返回了");
}

describe("创建期判定", () => {
  // 未出现在 allowedConsumers 里的 consumer 在创建期就被拒绝，且不发出任何请求。
  test("未授权 consumer 创建即拒，不发请求", async () => {
    const { calls, fetchImpl } = createFetchStub([]);
    const binding = bindingOf();

    await expectForbidden(async () => scopedFor(binding, "unknown-consumer", fetchImpl), "未获授权");
    expect(calls).toHaveLength(0);
  });

  // 空授权数组与「没有这个 consumer」等价：授权集合为空表示没有可用操作，交回客户端只会在业务路径上失败。
  test("授权集合为空的 consumer 创建即拒", async () => {
    const { calls, fetchImpl } = createFetchStub([]);
    const binding = bindingOf({ allowedConsumers: { tickets: [] } });

    await expectForbidden(async () => scopedFor(binding, "tickets", fetchImpl), "未获授权");
    expect(calls).toHaveLength(0);
  });

  // 连接与绑定错配是装配 bug：放任它会让请求打到另一台 Forgejo 上的同名仓库，必须当场失败而不是回一个 GitError。
  test("连接与绑定错配时报装配错误", () => {
    const { fetchImpl } = createFetchStub([]);
    const binding = bindingOf();

    expect(() =>
      createScopedClientFromBinding({
        binding,
        connection: { ...CONNECTION, id: "other" },
        consumerId: "tickets",
        serviceToken: SERVICE_TOKEN,
        client: new ForgejoClient({ baseUrl: CONNECTION.baseUrl, token: SERVICE_TOKEN, fetchImpl }),
      }),
    ).toThrow("装配错误");
  });
});

describe("作用域投影", () => {
  // 作用域三元组全部来自绑定记录，不接受调用方传入；消费者据此定位仓库，而不是靠请求参数。
  test("consumerId / organizationId / repository 取自绑定", () => {
    const { fetchImpl } = createFetchStub([]);
    const binding = bindingOf();

    const client = scopedFor(binding, "tickets", fetchImpl);

    expect(client.consumerId).toBe("tickets");
    expect(client.organizationId).toBe("org-1");
    expect(client.repository).toEqual({
      connectionId: CONNECTION.id,
      providerRepositoryId: "42",
      owner: "acme",
      name: "demo",
    });
  });
});

describe("每次调用的授权复查", () => {
  // 操作不在该 consumer 的集合内时拒绝，且拒绝发生在请求之前（issues.read 的消费者不得写工单）。
  test("操作不在集合内被拒且不发请求", async () => {
    const { calls, fetchImpl } = createFetchStub([]);
    const client = scopedFor(bindingOf(), "tickets", fetchImpl);

    await expectForbidden(() => client.issues.create({ title: "t", body: "b" }), "issues.write");
    expect(calls).toHaveLength(0);
  });

  // 绑定被暂停（status != active）时读写一律拒绝，且先报状态再报操作：暂停是对整条绑定的运维决定。
  test("status=paused 时读写一律被拒", async () => {
    const { calls, fetchImpl } = createFetchStub([]);
    const binding = bindingOf({
      status: "paused",
      allowedConsumers: { tickets: ["repositories.read", "issues.read", "issues.write"] },
    });
    const client = scopedFor(binding, "tickets", fetchImpl);

    await expectForbidden(() => client.issues.list(), "paused");
    await expectForbidden(() => client.issues.create({ title: "t", body: "b" }), "paused");
    expect(calls).toHaveLength(0);
  });

  // 复查用的是每次调用时读到的绑定快照：创建后被暂停的客户端，下一次调用必须立刻拒绝，不必等重启。
  test("创建后绑定被暂停，下一次调用立即拒绝", async () => {
    const { calls, fetchImpl } = createFetchStub([REPOSITORY_DTO]);
    const binding = bindingOf({ allowedConsumers: { tickets: ["repositories.read"] } });
    const client = scopedFor(binding, "tickets", fetchImpl);

    await client.repositories.get();
    expect(calls).toHaveLength(1);

    binding.status = "paused";
    await expectForbidden(() => client.repositories.get(), "paused");
    expect(calls).toHaveLength(1);
  });
});

describe("已授权时的透传", () => {
  // 读操作按绑定坐标拼接路径，凭据只进 Authorization 头；分页缺省值（page=1、limit=30）由适配器补齐。
  test("issues.list 透传到适配器并返回领域投影", async () => {
    const { calls, fetchImpl } = createFetchStub([[ISSUE_DTO]]);
    const client = scopedFor(bindingOf(), "tickets", fetchImpl);

    const page = await client.issues.list();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${REPOSITORY_URL}/issues?page=1&limit=30`);
    expect(calls[0]?.init?.method).toBe("GET");
    expect(headersOf(calls[0] as StubCall).authorization).toBe(`token ${SERVICE_TOKEN}`);
    expect(page.items[0]?.number).toBe("7");
  });

  // 单条读取用调用方给出的工单编号拼路径；编号是十进制字符串承载的领域值。
  test("issues.get 按编号拼路径", async () => {
    const { calls, fetchImpl } = createFetchStub([ISSUE_DTO]);
    const client = scopedFor(bindingOf(), "tickets", fetchImpl);

    const issue = await client.issues.get("7");

    expect(calls[0]?.url).toBe(`${REPOSITORY_URL}/issues/7`);
    expect(issue.title).toBe("工单标题");
  });

  // ensureIssuesEnabled 是仓库级写动作，归 `issues.write`：只读消费者不得借它改仓库设置。
  test("ensureIssuesEnabled 归 issues.write", async () => {
    const { calls, fetchImpl } = createFetchStub([REPOSITORY_DTO]);
    const writer = scopedFor(bindingOf({ allowedConsumers: { tickets: ["issues.write"] } }), "tickets", fetchImpl);

    await writer.repositories.ensureIssuesEnabled();
    expect(calls[0]?.init?.method).toBe("PATCH");
    expect(calls[0]?.url).toBe(REPOSITORY_URL);

    const reader = scopedFor(bindingOf({ allowedConsumers: { tickets: ["repositories.read"] } }), "tickets", fetchImpl);
    await expectForbidden(() => reader.repositories.ensureIssuesEnabled(), "issues.write");
  });

  // setLabels 是写操作（`issues.write`）且必须回读工单给出完整投影：PUT 之后再 GET 同一条工单。
  test("issues.setLabels 先 PUT 标签再回读工单", async () => {
    const { calls, fetchImpl } = createFetchStub([[], { ...ISSUE_DTO, labels: [{ id: 3, name: "bug" }] }]);
    const client = scopedFor(bindingOf({ allowedConsumers: { tickets: ["issues.write"] } }), "tickets", fetchImpl);

    const issue = await client.issues.setLabels("7", ["bug"]);

    expect(calls.map((call) => call.init?.method)).toEqual(["PUT", "GET"]);
    expect(calls[0]?.url).toBe(`${REPOSITORY_URL}/issues/7/labels`);
    expect(calls[1]?.url).toBe(`${REPOSITORY_URL}/issues/7`);
    expect(issue.labels.map((label) => label.name)).toEqual(["bug"]);
  });

  // 操作名逐组独立判定：只有 issues.read 的消费者不得读仓库或标签、不得发/改评论，避免某个操作名被整体放宽。
  test("各操作按自己的集合判定", async () => {
    const { calls, fetchImpl } = createFetchStub([]);
    const client = scopedFor(bindingOf({ allowedConsumers: { tickets: ["issues.read"] } }), "tickets", fetchImpl);

    await expectForbidden(() => client.repositories.get(), "repositories.read");
    await expectForbidden(() => client.labels.list(), "labels.read");
    await expectForbidden(() => client.labels.create({ name: "bug" }), "labels.write");
    await expectForbidden(() => client.comments.list("7"), "comments.read");
    await expectForbidden(() => client.comments.get("9"), "comments.read");
    await expectForbidden(() => client.comments.create("7", { body: "hi" }), "comments.write");
    await expectForbidden(() => client.comments.edit("9", { body: "hi" }), "comments.write");
    expect(calls).toHaveLength(0);
  });

  // 单条评论读取按绑定坐标与评论 ID 拼仓库作用域路径，工单编号来自响应的 issue_url（写入前的核验依据）。
  test("comments.get 按绑定坐标拼路径", async () => {
    const { calls, fetchImpl } = createFetchStub([
      {
        id: 9,
        body: "hi",
        user: { id: 11, login: "alice" },
        issue_url: `${CONNECTION.baseUrl}/api/v1/repos/acme/demo/issues/7`,
      },
    ]);
    const client = scopedFor(bindingOf({ allowedConsumers: { tickets: ["comments.read"] } }), "tickets", fetchImpl);

    const comment = await client.comments.get("9");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${REPOSITORY_URL}/issues/comments/9`);
    expect(calls[0]?.init?.method).toBe("GET");
    expect(comment.issueNumber).toBe("7");
    expect(comment.body).toBe("hi");
  });

  // 写评论时正文只在请求体里出现，凭据与正文都不进 URL。
  test("comments.create 把正文放进请求体", async () => {
    const { calls, fetchImpl } = createFetchStub([{ id: 9, body: "hi", user: { id: 11, login: "alice" } }]);
    const client = scopedFor(bindingOf({ allowedConsumers: { tickets: ["comments.write"] } }), "tickets", fetchImpl);

    const comment = await client.comments.create("7", { body: "hi" });

    expect(calls[0]?.url).toBe(`${REPOSITORY_URL}/issues/7/comments`);
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ body: "hi" }));
    expect(comment.issueNumber).toBe("7");
  });
});
