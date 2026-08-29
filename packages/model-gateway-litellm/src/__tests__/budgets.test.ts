import { describe, expect, test } from "bun:test";
import { createLiteLlmAdapter } from "@fenix/model-gateway-litellm";

describe("LiteLLM user budget adapter", () => {
  // 验证标准单用户预算查询使用 v2 接口，并保留预算、消耗和重置时间。
  test("reads one user budget from the LiteLLM v2 user info endpoint", async () => {
    const requests: Request[] = [];
    const adapter = createLiteLlmAdapter({
      baseUrl: "http://litellm.test",
      adminKey: "master-key",
      managementUiUrl: "http://litellm.test/ui",
      timeoutMs: 1000,
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          user_id: "gateway-user-1",
          max_budget: 100,
          spend: 12.5,
          budget_duration: "30d",
          budget_reset_at: "2026-09-01T00:00:00Z",
        });
      },
    });
    const getUserBudget = (
      adapter as unknown as {
        getUserBudget: (userId: string) => Promise<unknown>;
      }
    ).getUserBudget;

    await expect(getUserBudget("gateway-user-1")).resolves.toEqual({
      maxBudgetUsd: 100,
      duration: "30d",
      spendUsd: 12.5,
      resetAt: "2026-09-01T00:00:00Z",
    });
    expect(new URL(requests[0]!.url).pathname).toBe("/v2/user/info");
    expect(new URL(requests[0]!.url).searchParams.get("user_id")).toBe("gateway-user-1");
  });

  // 验证预算列表经 /user/list 分页读取，避免 /user/info 缺失预算字段并杜绝逐用户请求。
  test("lists paginated user budgets from the LiteLLM user list", async () => {
    const requests: Request[] = [];
    const adapter = createLiteLlmAdapter({
      baseUrl: "http://litellm.test",
      adminKey: "master-key",
      managementUiUrl: "http://litellm.test/ui",
      timeoutMs: 1000,
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const page = new URL(request.url).searchParams.get("page");
        return Response.json(
          page === "2"
            ? {
                users: [
                  {
                    user_id: "gateway-user-2",
                    max_budget: 80,
                    spend: 12,
                    budget_duration: "30d",
                  },
                ],
                total_pages: 2,
              }
            : {
                users: [
                  {
                    user_id: "gateway-user-1",
                    max_budget: 100,
                    spend: 4,
                    budget_duration: "30d",
                  },
                ],
                total_pages: 2,
              },
        );
      },
    });

    const listUserBudgets = (adapter as unknown as { listUserBudgets: () => Promise<unknown> }).listUserBudgets;

    await expect(listUserBudgets()).resolves.toEqual([
      {
        externalUserId: "gateway-user-1",
        maxBudgetUsd: 100,
        duration: "30d",
        spendUsd: 4,
        resetAt: null,
      },
      {
        externalUserId: "gateway-user-2",
        maxBudgetUsd: 80,
        duration: "30d",
        spendUsd: 12,
        resetAt: null,
      },
    ]);
    expect(requests.map((request) => new URL(request.url).pathname + new URL(request.url).search)).toEqual([
      "/user/list?page=1&page_size=100",
      "/user/list?page=2&page_size=100",
    ]);
  });

  // 验证指定 Internal User ID 时只向 LiteLLM 查询这批用户，而不读取全量列表。
  test("filters LiteLLM user budgets by Internal User IDs", async () => {
    const requests: Request[] = [];
    const adapter = createLiteLlmAdapter({
      baseUrl: "http://litellm.test",
      adminKey: "master-key",
      managementUiUrl: "http://litellm.test/ui",
      timeoutMs: 1000,
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({ users: [], total_pages: 1 });
      },
    });
    const listUserBudgets = (
      adapter as unknown as {
        listUserBudgets: (externalUserIds?: string[]) => Promise<unknown>;
      }
    ).listUserBudgets;

    await expect(listUserBudgets(["gateway-user-1", "gateway-user-2"])).resolves.toEqual([]);
    const requestUrl = new URL(requests[0]!.url);
    expect(requestUrl.searchParams.get("user_ids")).toBe("gateway-user-1,gateway-user-2");
  });

  // 验证批量重置只清零指定 Internal User 的消耗，并保留 LiteLLM 的逐项结果。
  test("resets selected user budgets through the LiteLLM bulk update endpoint", async () => {
    const requests: Request[] = [];
    const adapter = createLiteLlmAdapter({
      baseUrl: "http://litellm.test",
      adminKey: "master-key",
      managementUiUrl: "http://litellm.test/ui",
      timeoutMs: 1000,
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({
          results: [
            { user_id: "gateway-user-1", success: true },
            { user_id: "gateway-user-2", success: false, error: "not found" },
          ],
          total_requested: 2,
          successful_updates: 1,
          failed_updates: 1,
        });
      },
    });
    const resetUserBudgets = (
      adapter as unknown as {
        resetUserBudgets: (userIds: string[]) => Promise<unknown>;
      }
    ).resetUserBudgets;

    await expect(resetUserBudgets(["gateway-user-1", "gateway-user-2"])).resolves.toEqual({
      succeededExternalUserIds: ["gateway-user-1"],
      failed: [{ externalUserId: "gateway-user-2", error: "not found" }],
    });
    expect(new URL(requests[0]!.url).pathname).toBe("/user/bulk_update");
    expect(await requests[0]?.json()).toEqual({
      users: [
        { user_id: "gateway-user-1", spend: 0 },
        { user_id: "gateway-user-2", spend: 0 },
      ],
    });
  });

  // 验证不存在的 Internal User 按稳定 ID 创建，并把一次性预算映射为 LiteLLM 的长周期哨兵值。
  test("creates an internal user idempotently with a one-time budget", async () => {
    const requests: Request[] = [];
    const adapter = createLiteLlmAdapter({
      baseUrl: "http://litellm.test",
      adminKey: "master-key",
      managementUiUrl: "http://litellm.test/ui",
      timeoutMs: 1000,
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.includes("/user/info")) {
          return new Response("not found", { status: 404 });
        }
        return Response.json({
          user_id: "gateway-user-1",
          user_email: "user@example.com",
        });
      },
    });

    await expect(
      adapter.ensureUser({
        externalId: "gateway-user-1",
        email: "user@example.com",
        displayName: "User",
        budget: { maxBudgetUsd: 50, duration: null },
      }),
    ).resolves.toEqual({
      externalId: "gateway-user-1",
      email: "user@example.com",
    });

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "GET /user/info",
      "POST /user/new",
    ]);
    expect(await requests[1]?.json()).toEqual({
      user_id: "gateway-user-1",
      user_email: "user@example.com",
      user_alias: "User",
      user_role: "internal_user",
      auto_create_key: false,
      max_budget: 50,
      budget_duration: "2000d",
    });
  });

  // LiteLLM 有时以 HTTP 200 加错误对象表示用户不存在，适配器仍应走创建分支。
  test("creates a user when LiteLLM returns an application-level 404", async () => {
    let calls = 0;
    const adapter = createLiteLlmAdapter({
      baseUrl: "http://litellm.test",
      adminKey: "master-key",
      managementUiUrl: "http://litellm.test/ui",
      timeoutMs: 1000,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? Response.json({ error: { code: "404", message: "User not found" } })
          : Response.json({ user_id: "gateway-user-1" });
      },
    });

    await expect(adapter.ensureUser({ externalId: "gateway-user-1" })).resolves.toEqual({
      externalId: "gateway-user-1",
    });
  });

  // 验证预算更新保留 LiteLLM 周期语义，null 不伪造长期周期。
  test("updates a periodic budget", async () => {
    const requests: Request[] = [];
    const adapter = createLiteLlmAdapter({
      baseUrl: "http://litellm.test",
      adminKey: "master-key",
      managementUiUrl: "http://litellm.test/ui",
      timeoutMs: 1000,
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          user_id: "gateway-user-1",
          max_budget: 50,
          spend: 4,
          budget_duration: "30d",
        });
      },
    });

    await expect(
      adapter.updateUserBudget({
        externalUserId: "gateway-user-1",
        maxBudgetUsd: 50,
        duration: "30d",
      }),
    ).resolves.toMatchObject({ maxBudgetUsd: 50, duration: "30d" });
    expect(await requests[0]?.json()).toEqual({
      user_id: "gateway-user-1",
      max_budget: 50,
      budget_duration: "30d",
    });
  });

  // 验证一次性预算写入 LiteLLM 长周期哨兵值，读取时恢复为 Fenix 的 null 语义。
  test("updates a one-time budget through the long-duration sentinel", async () => {
    const requests: Request[] = [];
    const adapter = createLiteLlmAdapter({
      baseUrl: "http://litellm.test",
      adminKey: "master-key",
      managementUiUrl: "http://litellm.test/ui",
      timeoutMs: 1000,
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          user_id: "gateway-user-1",
          max_budget: 50,
          spend: 4,
          budget_duration: "2000d",
          budget_reset_at: "2032-02-19T00:00:00Z",
        });
      },
    });

    await expect(
      adapter.updateUserBudget({
        externalUserId: "gateway-user-1",
        maxBudgetUsd: 50,
        duration: null,
      }),
    ).resolves.toMatchObject({ maxBudgetUsd: 50, duration: null, resetAt: null });
    expect(await requests[0]?.json()).toEqual({
      user_id: "gateway-user-1",
      max_budget: 50,
      budget_duration: "2000d",
    });
  });

  // LiteLLM 对未设置预算上限的用户可能省略 max_budget，读取列表时应按不限额处理。
  test("treats an omitted budget limit as unlimited", async () => {
    const adapter = createLiteLlmAdapter({
      baseUrl: "http://litellm.test",
      adminKey: "master-key",
      managementUiUrl: "http://litellm.test/ui",
      timeoutMs: 1000,
      fetchImpl: async () => Response.json({ users: [{ user_id: "gateway-user-1", spend: 4 }] }),
    });

    await expect(adapter.listUserBudgets()).resolves.toEqual([
      {
        externalUserId: "gateway-user-1",
        maxBudgetUsd: null,
        duration: null,
        spendUsd: 4,
        resetAt: null,
      },
    ]);
  });
});
