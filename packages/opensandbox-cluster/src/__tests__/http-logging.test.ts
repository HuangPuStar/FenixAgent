import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createRequestLogging, recordRequestError } from "../logging/http-logger";

function fixture() {
  const entries: { level: string; message: string; fields: Record<string, unknown> }[] = [];
  const log = (level: string) => (message: string, fields: Record<string, unknown>) => {
    entries.push({ level, message, fields });
  };
  const logging = createRequestLogging(["cluster-secret", "frp-secret"], { info: log("info"), error: log("error") });
  const app = new Elysia()
    .onRequest(logging.start)
    .mapResponse(logging.captureResponse)
    .onAfterResponse(logging.finish);
  const flush = async () => {
    for (let i = 0; i < 100 && entries.length < 2; i++) await Bun.sleep(2);
  };
  return { app, entries, flush };
}
// 请求和 JSON 响应记录同一 requestId、状态与耗时，日志读取不能消耗业务正文。
test("logs requests and responses with a shared ID without changing bodies", async () => {
  const { app, entries, flush } = fixture();
  app.post("/echo", ({ body }) => body);
  const body = { sandbox_id: "job", resources: { cpu: 0.5, memoryMb: 512 } };
  const response = await app.handle(
    new Request("http://cluster/echo?pool_id=p", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer cluster-secret" },
      body: JSON.stringify(body),
    }),
  );
  expect(await response.json()).toEqual(body);
  await flush();
  expect(entries).toHaveLength(2);
  expect(entries[0].fields.requestId).toBe(response.headers.get("x-request-id"));
  expect(entries[1].fields.requestId).toBe(entries[0].fields.requestId);
  expect(entries[0].fields.request).toMatchObject({
    method: "POST",
    path: "/echo",
    search: { pool_id: "p" },
    data: body,
  });
  expect(entries[1].fields.response).toMatchObject({ status: 200, data: body, durationMs: expect.any(Number) });
});
// 密钥、Cookie、嵌套环境变量和 FRP 路径令牌不能通过任一日志字段泄漏。
test("redacts credentials in URL, headers, JSON and error diagnostics", async () => {
  const { app, entries, flush } = fixture();
  app.post("/internal/frp/plugin/:pathToken", ({ request, set }) => {
    recordRequestError(
      request,
      new Error("failed Bearer cluster-secret at https://user:pass@node/path?api_key=other-secret"),
    );
    set.status = 500;
    return {
      error: { message: "failed cluster-secret" },
      token: "response-secret",
      environment: { CUSTOM: "env-secret" },
    };
  });
  const response = await app.handle(
    new Request("http://cluster/internal/frp/plugin/frp-secret?api_key=query-secret", {
      method: "POST",
      headers: {
        authorization: "Bearer cluster-secret",
        cookie: "session=cookie-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        api_key: "node-secret",
        environment: { CUSTOM: "env-secret" },
        sandbox: { image: { auth: { password: "registry-secret" } } },
      }),
    }),
  );
  await response.text();
  await flush();
  const text = JSON.stringify(entries);
  for (const secret of [
    "cluster-secret",
    "frp-secret",
    "query-secret",
    "node-secret",
    "env-secret",
    "registry-secret",
    "response-secret",
    "cookie-secret",
    "user:pass",
    "other-secret",
  ])
    expect(text).not.toContain(secret);
  expect(text).toContain("[REDACTED]");
  expect(entries[1].level).toBe("error");
  expect(entries[1].fields.error).toMatchObject({ type: "Error", stack: expect.any(String) });
});
// 有界正文与未知长度正文都要限制读取，流式、文件和不支持的媒体类型不能被日志消费。
test("omits large and streaming responses while preserving the client stream", async () => {
  for (const kind of ["large", "sse", "download", "unknown-large", "stalled"] as const) {
    const { app, entries, flush } = fixture();
    let cancelled = false;
    app.get("/special", () =>
      kind === "sse"
        ? new Response("data: ready\n\n", { headers: { "content-type": "text/event-stream" } })
        : kind === "download"
          ? new Response("secret config", {
              headers: { "content-type": "application/toml", "content-disposition": "attachment" },
            })
          : kind === "stalled"
            ? new Response(
                new ReadableStream({
                  cancel() {
                    cancelled = true;
                  },
                }),
                { headers: { "content-type": "application/json" } },
              )
            : new Response(JSON.stringify({ value: "x".repeat(20000) }), {
                headers: {
                  "content-type": "application/json",
                  ...(kind === "large" ? { "content-length": "20012" } : {}),
                },
              }),
    );
    const response = await app.handle(new Request("http://cluster/special"));
    await flush();
    expect(entries).toHaveLength(2);
    expect(entries[1].fields.response).toMatchObject({ status: 200, omitted: expect.any(String) });
    expect(JSON.stringify(entries).length).toBeLessThan(4000);
    if (kind === "stalled") {
      expect(cancelled).toBe(false);
      void response.body?.cancel();
    } else expect((await response.text()).length).toBeGreaterThan(0);
  }
});
// 捕获异常、已处理的错误响应和鉴权提前返回都必须输出错误日志。
test("logs thrown and handled errors including early responses", async () => {
  for (const path of ["/throw", "handled", "early"]) {
    const { app, entries, flush } = fixture();
    app
      .onError(({ set }) => {
        set.status = 500;
        return { error: { message: "mapped failure" } };
      })
      .get("/throw", () => {
        throw new Error("diagnostic failure");
      })
      .get("/handled", ({ set }) => {
        set.status = 409;
        return { error: { code: "NO_CAPACITY", message: "no capacity" } };
      })
      .get("/early", () => ({ ok: true }), {
        beforeHandle: () => Response.json({ error: { message: "invalid credentials" } }, { status: 401 }),
      });
    const response = await app.handle(new Request("http://cluster/" + path.replace(/^\//, "")));
    await response.text();
    await flush();
    expect(entries[1].level).toBe("error");
    expect(entries[1].fields.response).toMatchObject({ status: response.status });
    if (path === "/throw")
      expect(entries[1].fields.error).toMatchObject({ message: "diagnostic failure", stack: expect.any(String) });
  }
});
// 并发请求须维持独立关联号，不允许响应与另一请求的参数串线。
test("isolates concurrent request IDs", async () => {
  const { app, entries } = fixture();
  let resume: () => void = () => {};
  app
    .get("/slow", async () => {
      await new Promise<void>((r) => {
        resume = r;
      });
      return { id: "slow" };
    })
    .get("/fast", () => ({ id: "fast" }));
  const slow = app.handle(new Request("http://cluster/slow?job=slow"));
  for (let i = 0; i < 100 && entries.length === 0; i++) await Bun.sleep(1);
  const fast = await app.handle(new Request("http://cluster/fast?job=fast"));
  resume();
  const first = await slow;
  for (let i = 0; i < 100 && entries.length < 4; i++) await Bun.sleep(2);
  expect(first.headers.get("x-request-id")).not.toBe(fast.headers.get("x-request-id"));
  for (const path of ["/slow", "/fast"]) {
    const matching = entries.filter((e) => (e.fields.request as { path: string }).path === path);
    expect(matching).toHaveLength(2);
    expect(matching[0].fields.requestId).toBe(matching[1].fields.requestId);
  }
});
// 解析失败、框架校验及实际子路由的提前返回都应经过统一日志，并避免回显校验原文。
test("covers mounted cluster routes, proxy errors and validation failures", async () => {
  const { createAppWithDatabase } = await import("../app");
  const { createDatabase } = await import("../db/client");
  const { migrateConnection } = await import("../db/migrate");
  const { loadConfig } = await import("../config");
  const handle = createDatabase(":memory:");
  migrateConnection(handle.db, handle.sqlite);
  const config = loadConfig({
    SERVER_API_KEY_ENCRYPTION_KEY: "0".repeat(32),
    CLUSTER_SERVICE_API_KEY: "cluster-secret",
    FRP_TOKEN: "frp-secret",
    FRP_PUBLIC_ADDRESS: "localhost",
  });
  const entries: { level: string; fields: Record<string, unknown> }[] = [];
  const emit = (level: string) => (_message: string, fields: Record<string, unknown>) => {
    entries.push({ level, fields });
  };
  const app = createAppWithDatabase(config, handle.db, handle.sqlite, {
    httpLog: { info: emit("info"), error: emit("error") },
  });
  try {
    const paths = [
      ["/api/v1/pools", "GET", undefined, false],
      ["/api/v1/pools", "POST", { name: "missing-id" }, true],
      ["/api/v2/pools/no-pool/sandboxes", "POST", { password: "validation-secret" }, true],
      ["/api/v1/sandboxes/no-binding/proxy/v1/sandboxes", "GET", undefined, true],
      ["/missing", "GET", undefined, true],
      ["/internal/frp/plugin/frp-secret", "POST", { op: "Unknown" }, false],
    ] as const;
    for (const [path, method, body, auth] of paths) {
      const response = await app.handle(
        new Request("http://cluster" + path, {
          method,
          headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer cluster-secret" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        }),
      );
      await response.text();
      for (let i = 0; i < 100 && entries.length < 2; i++) await Bun.sleep(2);
      expect(entries).toHaveLength(2);
      expect(entries[1].level).toBe("error");
      expect(entries[1].fields.response).toMatchObject({ status: response.status });
      if (path.includes("/api/v2/")) expect(JSON.stringify(entries)).not.toContain("validation-secret");
      entries.length = 0;
    }
  } finally {
    handle.sqlite.close();
  }
});
// Elysia 覆盖原生 Response 状态码后，日志必须采用客户端实际收到的状态。
test("uses final Elysia status overrides when logging native responses", async () => {
  const { app, entries, flush } = fixture();
  app.get("/override", ({ set }) => {
    set.status = 503;
    return Response.json({ error: { message: "offline" } });
  });
  const response = await app.handle(new Request("http://cluster/override"));
  await response.text();
  await flush();
  expect(response.status).toBe(503);
  expect(entries[1].fields.response).toMatchObject({ status: 503 });
  expect(entries[1].level).toBe("error");
});
// 独立 FRP 端口的 HTTP 200 协议拒绝同样输出错误，路径令牌不得泄漏。
test("logs protocol rejections on the separate FRP host", async () => {
  const { createLoggedFrpPluginApp } = await import("../routes/frp-plugin");
  const { FrpPluginService } = await import("../services/frp-plugin-service");
  const { createDatabase } = await import("../db/client");
  const { loadConfig } = await import("../config");
  const handle = createDatabase(":memory:");
  const config = loadConfig({
    SERVER_API_KEY_ENCRYPTION_KEY: "0".repeat(32),
    CLUSTER_SERVICE_API_KEY: "cluster-secret",
    FRP_TOKEN: "frp-secret",
    FRP_PUBLIC_ADDRESS: "localhost",
  });
  const entries: { level: string; fields: Record<string, unknown> }[] = [];
  const emit = (level: string) => (_message: string, fields: Record<string, unknown>) => {
    entries.push({ level, fields });
  };
  try {
    const app = createLoggedFrpPluginApp(config, new FrpPluginService(handle.db), {
      info: emit("info"),
      error: emit("error"),
    });
    const response = await app.handle(
      new Request("http://plugin/internal/frp/plugin/frp-secret", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "Unknown" }),
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toMatchObject({ reject: true });
    for (let i = 0; i < 100 && entries.length < 2; i++) await Bun.sleep(2);
    expect(entries).toHaveLength(2);
    expect(entries[1].level).toBe("error");
    expect(JSON.stringify(entries)).not.toContain("frp-secret");
  } finally {
    handle.sqlite.close();
  }
});
// 带 cause 的异常也必须在任何中间诊断转换截断前遮蔽部署密钥。
test("redacts truncated errors and causes through the HTTP logger", async () => {
  const { app, entries, flush } = fixture();
  app.get("/cause", () => {
    throw new Error("x".repeat(2043) + "cluster-secret", { cause: new Error("y".repeat(2043) + "cluster-secret") });
  });
  const response = await app.handle(new Request("http://cluster/cause"));
  await response.text();
  await flush();
  expect(entries[1].level).toBe("error");
  expect(JSON.stringify(entries)).not.toContain("cluster-se");
});
