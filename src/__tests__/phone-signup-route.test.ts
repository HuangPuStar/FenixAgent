import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { authPlugin } from "../plugins/auth";
import { resetAllStubs, stubAuthHandler, stubDb } from "../test-utils/helpers";

function createUserLookupDb(rows: Array<{ id: string }>) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => rows,
        }),
      }),
    }),
  };
}

describe("phone sign-up route", () => {
  beforeEach(() => {
    stubDb(createUserLookupDb([]));
  });

  afterEach(() => {
    resetAllStubs();
  });

  // 应将手机号注册请求改写为 better-auth 邮箱注册请求，并写入临时邮箱与归一化手机号。
  test("POST /api/auth/sign-up/phone rewrites to sign-up/email", async () => {
    let forwardedUrl = "";
    let forwardedBody: Record<string, unknown> | null = null;

    stubAuthHandler(async (request) => {
      forwardedUrl = request.url;
      forwardedBody = (await request.json()) as Record<string, unknown>;
      return Response.json({ ok: true, forwardedBody });
    });

    const response = await authPlugin.handle(
      new Request("http://localhost/api/auth/sign-up/phone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "li",
          phoneNumber: "+86 188 2648 0215",
          password: "plain-password",
        }),
      }),
    );

    const json = await response.json();

    expect(response.status).toBe(200);
    expect(forwardedUrl).toBe("http://localhost/api/auth/sign-up/email");
    expect(forwardedBody as Record<string, unknown> | null).toEqual({
      name: "li",
      email: "18826480215@fenix.com",
      phoneNumber: "18826480215",
      password: "plain-password",
    });
    expect(json as unknown).toEqual({
      ok: true,
      forwardedBody: {
        name: "li",
        email: "18826480215@fenix.com",
        phoneNumber: "18826480215",
        password: "plain-password",
      },
    });
  });

  // 应在手机号重复时返回 422，而不是把唯一索引错误透传成 500。
  test("POST /api/auth/sign-up/phone returns 422 when phone number already exists", async () => {
    stubDb(createUserLookupDb([{ id: "user-1" }]));

    const response = await authPlugin.handle(
      new Request("http://localhost/api/auth/sign-up/phone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "li",
          phoneNumber: "18826480215",
          password: "plain-password",
        }),
      }),
    );

    expect(response.status).toBe(422);
    expect((await response.json()) as unknown).toEqual({
      code: "PHONE_NUMBER_EXISTS",
      message: "该手机号已注册",
    });
  });
});
