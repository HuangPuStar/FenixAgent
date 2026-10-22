import { expect, test } from "bun:test";
import { createOtelProxy, inspectPublicOrigin, MAX_OTLP_BODY_BYTES } from "../telemetry/browser-proxy";

const request = (body: Uint8Array = new Uint8Array([1]), headers: Record<string, string> = {}) => {
  const requestHeaders = new Headers({ "Content-Type": "application/x-protobuf" });
  requestHeaders.set("Origin", headers.Origin ?? headers.origin ?? "http://localhost");
  for (const [key, value] of Object.entries(headers)) {
    if (key !== "origin" && key !== "Origin") requestHeaders.set(key, value);
  }
  return new Request("http://localhost/otel/v1/logs", { method: "POST", headers: requestHeaders, body });
};

// 浏览器遥测只能转到独立 receiver，Cookie 和认证头不得透传到上游。
test("代理认证并原样转发 protobuf，不透传凭据", async () => {
  let target = "";
  let headers = new Headers();
  const app = createOtelProxy({
    endpoint: "http://collector:4319",
    authenticate: async () => "user-1",
    fetch: async (url, init) => {
      target = String(url);
      headers = new Headers(init?.headers);
      return new Response(new Uint8Array([2]));
    },
  });
  const response = await app.handle(request());
  expect(response.status).toBe(200);
  expect(target).toBe("http://collector:4319/v1/logs");
  expect(headers.has("cookie")).toBe(false);
  expect(headers.has("authorization")).toBe(false);
});

// 体积上限必须覆盖无 Content-Length 的流式输入，压缩输入直接拒绝。
test("代理强制体积与压缩限制", async () => {
  let forwarded = 0;
  const app = createOtelProxy({
    endpoint: "http://collector:4319",
    authenticate: async () => "user-1",
    fetch: async () => {
      forwarded++;
      return new Response();
    },
  });
  expect((await app.handle(request(new Uint8Array(MAX_OTLP_BODY_BYTES + 1)))).status).toBe(413);
  const compressed = request();
  compressed.headers.set("content-encoding", "gzip");
  expect((await app.handle(compressed)).status).toBe(415);
  expect(forwarded).toBe(0);
});

// 单用户超限不可继续占用 Collector，时间窗结束后恢复。
test("代理按认证用户限流并在窗口结束后恢复", async () => {
  let time = 1000;
  const app = createOtelProxy({
    endpoint: "http://collector:4319",
    authenticate: async () => "user-1",
    now: () => time,
    fetch: async () => new Response(),
  });
  for (let index = 0; index < 60; index++) expect((await app.handle(request())).status).toBe(200);
  expect((await app.handle(request())).status).toBe(429);
  time += 60_000;
  expect((await app.handle(request())).status).toBe(200);
});

// 跨站与未认证输入不能利用观测代理；关闭时不得访问任何上游。
test("代理拒绝跨站、匿名和禁用路径", async () => {
  const app = createOtelProxy({ endpoint: "http://collector:4319", authenticate: async () => null });
  expect((await app.handle(request())).status).toBe(401);
  const crossOrigin = request(new Uint8Array([1]), { origin: "http://other.test" });
  expect((await app.handle(crossOrigin)).status).toBe(403);
  expect((await createOtelProxy({ authenticate: async () => null }).handle(request())).status).toBe(404);
});

// TLS 在反代终止时以配置的公开 origin 校验；转发头不参与判定，缺失或跨站一律拒绝。
test("代理按配置的公开 origin 接受 HTTPS，并忽略不可信的转发头", async () => {
  const app = createOtelProxy({
    endpoint: "http://collector:4319",
    publicBaseUrl: "https://fenix.example.com/ctrl",
    authenticate: async () => "user-1",
    fetch: async () => new Response(),
  });
  const httpsOrigin = request(new Uint8Array([1]), { origin: "https://fenix.example.com" });
  expect((await app.handle(httpsOrigin)).status).toBe(200);

  const missing = new Request("http://localhost/otel/v1/logs", {
    method: "POST",
    headers: { "Content-Type": "application/x-protobuf" },
    body: new Uint8Array([1]),
  });
  expect((await app.handle(missing)).status).toBe(403);

  const forged = request(new Uint8Array([1]), {
    origin: "https://fenix.example.com",
    "x-forwarded-host": "evil.example.com",
    "x-forwarded-proto": "https",
  });
  expect((await app.handle(forged)).status).toBe(200);
  const wrong = request(new Uint8Array([1]), { origin: "https://evil.example.com" });
  expect((await app.handle(wrong)).status).toBe(403);

  const noConfiguredOrigin = createOtelProxy({ endpoint: "http://collector:4319", authenticate: async () => "user-1" });
  const tlsOriginOnPlainRequest = request(new Uint8Array([1]), {
    origin: "https://localhost",
    "x-forwarded-proto": "https",
  });
  expect((await noConfiguredOrigin.handle(tlsOriginOnPlainRequest)).status).toBe(403);
});

// 公开 origin 只接受单个合法 HTTP(S)，缺失/非法/localhost 必须 fail-closed。
test("公开 origin 校验拒绝缺失、非法和 localhost", async () => {
  expect(inspectPublicOrigin(undefined)).toEqual({ issue: "missing" });
  expect(inspectPublicOrigin("not a url")).toEqual({ issue: "invalid" });
  expect(inspectPublicOrigin("https://user:pass@fenix.example.com")).toEqual({ issue: "invalid" });
  expect(inspectPublicOrigin("http://localhost:3000")).toEqual({ issue: "localhost" });
  expect(inspectPublicOrigin("http://127.0.0.1:3000")).toEqual({ issue: "localhost" });
  expect(inspectPublicOrigin("https://fenix.example.com/ctrl")).toEqual({ origin: "https://fenix.example.com" });

  const app = createOtelProxy({
    endpoint: "http://collector:4319",
    requireConfiguredOrigin: true,
    authenticate: async () => "user-1",
    fetch: async () => new Response(),
  });
  expect((await app.handle(request())).status).toBe(403);

  const localhost = createOtelProxy({
    endpoint: "http://collector:4319",
    publicBaseUrl: "http://localhost:3000",
    requireConfiguredOrigin: true,
    authenticate: async () => "user-1",
    fetch: async () => new Response(),
  });
  expect((await localhost.handle(request())).status).toBe(403);
});

// 空闲用户不能永久占用槽位：窗口滚动后必须释放，新用户才能进入。
test("窗口滚动释放空闲用户槽位", async () => {
  let time = 1000;
  const app = createOtelProxy({
    endpoint: "http://collector:4319",
    maxClients: 2,
    authenticate: async (incoming) => incoming.headers.get("x-test-user"),
    now: () => time,
    fetch: async () => new Response(),
  });
  const asUser = (user: string) => request(new Uint8Array([1]), { "x-test-user": user });
  expect((await app.handle(asUser("user-a"))).status).toBe(200);
  expect((await app.handle(asUser("user-b"))).status).toBe(200);
  expect((await app.handle(asUser("user-c"))).status).toBe(429);
  time += 60_000;
  expect((await app.handle(asUser("user-c"))).status).toBe(200);
});

// 跨窗口在飞 bucket 不能提前回收；最后一个请求结束后应释放槽位。
test("在飞用户跨滚动保留，完成后回收槽位", async () => {
  let time = 1000;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const app = createOtelProxy({
    endpoint: "http://collector:4319",
    maxClients: 1,
    authenticate: async (incoming) => incoming.headers.get("x-test-user"),
    now: () => time,
    fetch: async () => {
      await gate;
      return new Response();
    },
  });
  const asUser = (user: string) => request(new Uint8Array([1]), { "x-test-user": user });
  const slow = app.handle(asUser("user-a"));
  await Bun.sleep(10);
  time += 60_000;
  expect((await app.handle(asUser("user-b"))).status).toBe(429);
  release?.();
  expect((await slow).status).toBe(200);
  expect((await app.handle(asUser("user-b"))).status).toBe(200);
});

// 速率窗口滚动不能清零在飞计数：跨窗口的慢请求仍占住该用户并发额度。
test("代理窗口滚动后仍保留在飞并发限制", async () => {
  let time = 1000;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const app = createOtelProxy({
    endpoint: "http://collector:4319",
    authenticate: async () => "user-1",
    now: () => time,
    fetch: async () => {
      await gate;
      return new Response();
    },
  });
  const first = app.handle(request());
  const second = app.handle(request());
  await Bun.sleep(10);
  time += 60_000;
  expect((await app.handle(request())).status).toBe(429);
  release?.();
  expect((await Promise.all([first, second])).map((response) => response.status)).toEqual([200, 200]);
  expect((await app.handle(request())).status).toBe(200);
});

// 单个用户最多占用两个在飞请求，避免慢上游占满全局并发。
test("代理限制每用户并发且释放后恢复", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let forwarded = 0;
  const app = createOtelProxy({
    endpoint: "http://collector:4319",
    authenticate: async () => "user-1",
    fetch: async () => {
      forwarded++;
      await gate;
      return new Response();
    },
  });
  const first = app.handle(request());
  const second = app.handle(request());
  await Bun.sleep(10);
  expect((await app.handle(request())).status).toBe(429);
  expect(forwarded).toBe(2);
  release?.();
  expect((await Promise.all([first, second])).map((response) => response.status)).toEqual([200, 200]);
  expect((await app.handle(request())).status).toBe(200);
});
