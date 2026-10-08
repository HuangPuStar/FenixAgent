import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { createCanvasStaticRoutes } from "../server/routes/canvas/static-proxy";
import { getUpstreamSession } from "../server/services/upstream-session";
import { initializeWorkflowV2ModuleConfig } from "../server/testing";

/**
 * 画布静态反代（1E）的行为契约测试：冻结 §2.1.1 的出站注入与入站剥离、§6.1 的存储域反代。
 *
 * 上游一律用 `Bun.serve` 起的本地假实例（一个冒充上游、一个冒充对象存储），不依赖真实上游；真实实例的
 * 响应形态已由契约快照固化（`docs/design/2026-09-29-workflow-v2-upstream-contract-snapshot.md`），本文件只
 * 验证我方行为：路径映射、会话注入与重放、响应头白名单、SPA 回退、方法门与流式透传。
 *
 * 两个假上游都是**整文件共用一个实例**（`beforeAll` 起、`afterAll` 停），用例只替换响应处理器：`Bun.serve`
 * 反复释放/重绑端口会让进程内 fetch 的连接池偶发拿到已停服务的 keep-alive 连接（同 `upstream-session.test.ts`
 * 的取舍）。存储域解析是代理实例内的闭包状态，因此每个用例都重建一次路由，避免用例间互相污染。
 *
 * 本文件所有凭据都是明显假的 fixture（保留域邮箱 + 固定前缀），不使用也不记录真实凭据。
 */

const TEST_EMAIL = "workflow-v2-canvas@example.invalid";
const TEST_PASSWORD = "fixture-password-9c0e-not-a-secret";
const COOKIE_VALUE = "session-key-fixture-7d31";

/** 本面挂载前缀（与 `static-proxy.ts` 的 Elysia prefix 一致）。 */
const CANVAS_PREFIX = "/workflow-canvas";

/** 假上游记录的一条请求；凭据类字段只保留断言需要的形状。 */
interface RecordedRequest {
  method: string;
  /** 路径 + 查询串。 */
  path: string;
  cookie: string | null;
  /** 画布票据头：静态面不该外发它（票据只服务 bff 面）。 */
  ticket: string | null;
}

let upstreamServer: ReturnType<typeof Bun.serve> | null = null;
let storageServer: ReturnType<typeof Bun.serve> | null = null;

/** 假上游收到的请求（当前用例的）；`setup()` 就地清空，保持引用稳定。 */
const upstreamRequests: RecordedRequest[] = [];
/** 假对象存储收到的请求（当前用例的）。 */
const storageRequests: RecordedRequest[] = [];

/** 未设置处理器就发请求时立刻以 500 暴露，而不是静默返回空响应。 */
function unsetHandler(): Response {
  return new Response("用例未设置假上游处理器", { status: 500 });
}
let upstreamHandler: (request: RecordedRequest) => Response | Promise<Response> = unsetHandler;
let storageHandler: (request: RecordedRequest) => Response | Promise<Response> = unsetHandler;

/** 记录一次请求；HEAD/GET 无请求体，这里不读 body（反代本来也不转发请求体）。 */
function record(request: Request): RecordedRequest {
  const url = new URL(request.url);
  return {
    method: request.method,
    path: `${url.pathname}${url.search}`,
    cookie: request.headers.get("cookie"),
    ticket: request.headers.get("x-fenix-workflow-ticket"),
  };
}

beforeAll(() => {
  upstreamServer = Bun.serve({
    port: 0,
    fetch(request) {
      const recorded = record(request);
      upstreamRequests.push(recorded);
      return upstreamHandler(recorded);
    },
  });
  storageServer = Bun.serve({
    port: 0,
    fetch(request) {
      const recorded = record(request);
      storageRequests.push(recorded);
      return storageHandler(recorded);
    },
  });
});

afterAll(() => {
  upstreamServer?.stop(true);
  storageServer?.stop(true);
  upstreamServer = null;
  storageServer = null;
});

afterEach(() => {
  resetAllStubs();
  upstreamHandler = unsetHandler;
  storageHandler = unsetHandler;
});

/** 假上游基址；未启动即使用说明用例顺序错了。 */
function upstreamBaseUrl(): string {
  if (upstreamServer === null) throw new Error("假上游尚未启动");
  return `http://127.0.0.1:${upstreamServer.port}`;
}

/** 假对象存储基址。 */
function storageBaseUrl(): string {
  if (storageServer === null) throw new Error("假对象存储尚未启动");
  return `http://127.0.0.1:${storageServer.port}`;
}

/** 正常登录响应；`domain` 带端口的非法 Cookie 是上游实测形态（正是会话模块手工解析的理由）。 */
function loginOk(): Response {
  return new Response(JSON.stringify({ code: 0, msg: "success", data: { user_id_str: "upstream-user-fixture" } }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": `session_key=${COOKIE_VALUE}; max-age=2592000; path=/`,
    },
  });
}

/** 上游判定会话失效的实测形态：HTTP 200 + 业务码，不是 401（设计 §9.1.1 第 1 条）。 */
function sessionInvalid(): Response {
  return new Response(JSON.stringify({ code: 700012006, msg: "authentication failed: session not exist" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** 在给定毫秒内未完成即失败：用于「首块必须早于上游结束到达」这类时序断言。 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
    }),
  ]);
}

/** 构造被测路由；每个用例重建一次，代理实例的存储域解析状态不跨用例泄漏。 */
function setup(
  handler: (request: RecordedRequest) => Response | Promise<Response>,
  overrides: { canvasUpstreamUrl?: string } = {},
) {
  upstreamHandler = handler;
  storageHandler = unsetHandler;
  upstreamRequests.length = 0;
  storageRequests.length = 0;
  initializeWorkflowV2ModuleConfig({
    upstreamBaseUrl: upstreamBaseUrl(),
    canvasUpstreamUrl: overrides.canvasUpstreamUrl ?? upstreamBaseUrl(),
    accountEmail: TEST_EMAIL,
    accountPassword: TEST_PASSWORD,
  });
  // 会话是进程单例：用例之间必须显式作废，否则会拿到上一个用例（或上一个测试文件）的会话值。
  getUpstreamSession().invalidate();
  return { app: createCanvasStaticRoutes(), requests: upstreamRequests };
}

/** 对被测路由发一次请求；`headers` 用于构造「浏览器带着控制台会话」的入站请求。 */
function call(
  app: ReturnType<typeof createCanvasStaticRoutes>,
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
) {
  return app.handle(new Request(`http://console.invalid${path}`, { method, headers }));
}

describe("canvas-static-proxy", () => {
  // 静态资产透传：出站带平台会话，入站剥离 Set-Cookie 与 X-Frame-Options，并注入 frame-ancestors。
  test("静态资产透传：出站注入会话、入站剥离会话材料并注入 CSP", async () => {
    const { app, requests } = setup((recorded) => {
      if (recorded.path.startsWith("/api/passport/")) return loginOk();
      return new Response("console.log(1)", {
        status: 200,
        headers: {
          "content-type": "application/javascript",
          "cache-control": "public, max-age=60",
          etag: '"asset-1"',
          "set-cookie": `session_key=${COOKIE_VALUE}; path=/`,
          "x-frame-options": "DENY",
        },
      });
    });

    const response = await call(app, `${CANVAS_PREFIX}/static/js/app.js?v=7`, "GET", {
      cookie: "better-auth.session_token=console-session-fixture",
      "x-fenix-workflow-ticket": "console-ticket-fixture",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("console.log(1)");
    const assetRequest = requests.find((request) => request.path.startsWith("/static/js/app.js"));
    expect(assetRequest?.method).toBe("GET");
    // 出站：资产请求必须带上平台账号会话，否则上游对 /static/js 也返回 401。
    expect(assetRequest?.cookie).toBe(`session_key=${COOKIE_VALUE}`);
    // 出站方向只带平台会话：浏览器的控制台会话 cookie 与票据头都不得出境到上游。
    expect(assetRequest?.cookie).not.toContain("console-session-fixture");
    expect(assetRequest?.ticket).toBeNull();
    expect(assetRequest?.path).toBe("/static/js/app.js?v=7");
    // 入站：上游 Set-Cookie 与会拒绝被 iframe 嵌入的 X-Frame-Options 都不得到浏览器。
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'self'; frame-src 'self'");
    // 安全子集（缓存与类型）照常保留，否则画布拿不到协商结果与缓存语义。
    expect(response.headers.get("content-type")).toBe("application/javascript");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.headers.get("etag")).toBe('"asset-1"');
  });

  // 根路径映射：`/workflow-canvas/` 与不带尾斜杠的入口都落上游 `/`，且上游注册路径不重复挂载。
  test("根路径映射到上游根文档", async () => {
    const { app, requests } = setup((recorded) => {
      if (recorded.path.startsWith("/api/passport/")) return loginOk();
      return new Response("<html>index</html>", { status: 200, headers: { "content-type": "text/html" } });
    });

    const response = await call(app, `${CANVAS_PREFIX}/`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>index</html>");
    expect(requests.filter((request) => !request.path.startsWith("/api/")).map((request) => request.path)).toEqual([
      "/",
    ]);

    // 不带尾斜杠的入口（宿主 iframe src 的常见写法）必须同样落上游 `/`，而不是被当成名为空段的资源。
    const bare = await call(app, CANVAS_PREFIX);
    expect(bare.status).toBe(200);
    expect(await bare.text()).toBe("<html>index</html>");
  });

  // 路径穿越拒绝：段内解码出的 `..` 不得参与拼接，被拒路径也不回显、不出站。
  test("路径穿越（%2F 编码的点段）返回 400 且不触达上游", async () => {
    const { app, requests } = setup(() => loginOk());

    const response = await call(app, `${CANVAS_PREFIX}/..%2F..%2Fadmin`);

    expect(response.status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  // 第二道保险：bff 前缀属透传面，即使本面先匹配到也只回上游形状 404，绝不代理成上游资产。
  test("bff 前缀不被静态反代处理", async () => {
    const { app, requests } = setup(() => loginOk());

    const response = await call(app, `${CANVAS_PREFIX}/bff/api/workflow_api/canvas`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: 404, msg: "not found" });
    expect(requests).toHaveLength(0);
  });

  // 方法门：静态面只服务 GET/HEAD，写请求必须 405 并带 Allow（写通道是 bff 面）。
  test("写方法与未知方法返回 405，HEAD 正常透传", async () => {
    const { app, requests } = setup((recorded) => {
      if (recorded.path.startsWith("/api/passport/")) return loginOk();
      return new Response("asset", { status: 200, headers: { "content-type": "application/javascript" } });
    });

    const posted = await call(app, `${CANVAS_PREFIX}/static/js/app.js`, "POST");
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET, HEAD");

    const head = await call(app, `${CANVAS_PREFIX}/static/js/app.js`, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(requests.filter((request) => !request.path.startsWith("/api/")).map((request) => request.method)).toEqual([
      "HEAD",
    ]);
  });

  // SPA 回退：非静态资源的上游 404 用根文档兜底并统一成 200，深链与刷新才不会整页 404。
  test("非静态资源的上游 404 回退到根文档并改为 200", async () => {
    const { app, requests } = setup((recorded) => {
      if (recorded.path.startsWith("/api/passport/")) return loginOk();
      if (recorded.path.startsWith("/work_flow")) return new Response("not found", { status: 404 });
      return new Response("<html>index</html>", { status: 200, headers: { "content-type": "text/html" } });
    });

    const response = await call(app, `${CANVAS_PREFIX}/work_flow?workflow_id=1&space_id=2`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>index</html>");
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(requests.filter((request) => !request.path.startsWith("/api/")).map((request) => request.path)).toEqual([
      "/work_flow?workflow_id=1&space_id=2",
      "/",
    ]);
  });

  // 静态资源的 404 不回退：把 index.html 当 JS 回给浏览器会变成难排查的语法错误，404 才是正确信号。
  test("静态资源的上游 404 原样回传，不回退根文档", async () => {
    const { app, requests } = setup((recorded) => {
      if (recorded.path.startsWith("/api/passport/")) return loginOk();
      return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
    });

    const response = await call(app, `${CANVAS_PREFIX}/static/js/missing.js`);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("missing");
    expect(requests.filter((request) => !request.path.startsWith("/api/"))).toHaveLength(1);
  });

  // 会话失效（HTTP 401）按 1B 机制重登并重放一次：重放成功则浏览器无感。
  test("上游 401 触发重登与重放一次", async () => {
    let assetAttempts = 0;
    const { app, requests } = setup((recorded) => {
      if (recorded.path.startsWith("/api/passport/")) return loginOk();
      assetAttempts += 1;
      if (assetAttempts === 1) return new Response("missing session_key", { status: 401 });
      return new Response("asset", { status: 200, headers: { "content-type": "application/javascript" } });
    });

    const response = await call(app, `${CANVAS_PREFIX}/static/js/app.js`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("asset");
    expect(assetAttempts).toBe(2);
    expect(requests.filter((request) => request.path === "/api/passport/web/email/login/")).toHaveLength(2);
  });

  // 实测形态的会话失效（HTTP 200 + 业务码 700012006）同样必须触发重放，否则会话过期后画布永久空白。
  test("业务码 700012006 触发重登与重放一次", async () => {
    let assetAttempts = 0;
    const { app } = setup((recorded) => {
      if (recorded.path.startsWith("/api/passport/")) return loginOk();
      assetAttempts += 1;
      if (assetAttempts === 1) return sessionInvalid();
      return new Response("asset", { status: 200, headers: { "content-type": "application/javascript" } });
    });

    const response = await call(app, `${CANVAS_PREFIX}/static/js/app.js`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("asset");
    expect(assetAttempts).toBe(2);
  });

  // 降级边界：重放后仍被判失效即 502（不循环重登），且上游文案不得出现在响应里。
  test("重登后仍失效返回 502 且不回显上游文案", async () => {
    const { app } = setup((recorded) => {
      if (recorded.path.startsWith("/api/passport/")) return loginOk();
      return sessionInvalid();
    });

    const response = await call(app, `${CANVAS_PREFIX}/static/js/app.js`);

    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain("画布上游会话不可用");
    expect(body).not.toContain("session not exist");
  });

  // 流式透传：首块必须在上游结束之前到达客户端，否则大 bundle 会被整段缓冲。
  test("响应体按流透传，不缓冲整段 body", async () => {
    let releaseTail: () => void = () => {};
    const tailGate = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    const { app } = setup((recorded) => {
      if (recorded.path.startsWith("/api/passport/")) return loginOk();
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode("chunk-1"));
            await tailGate;
            controller.enqueue(encoder.encode("chunk-2"));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "application/javascript" } },
      );
    });

    const response = await call(app, `${CANVAS_PREFIX}/static/js/big.js`);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) throw new Error("响应没有 body 流");

    const first = await withTimeout(reader.read(), 2000, "首块未在上游结束前到达：body 被整段缓冲了");
    expect(new TextDecoder().decode(first.value)).toBe("chunk-1");

    releaseTail();
    const second = await withTimeout(reader.read(), 2000, "尾块未到达");
    expect(new TextDecoder().decode(second.value)).toBe("chunk-2");
    await reader.cancel();
  });

  // 上游不可达映射为 502；会话仍可用（登录走另一个地址）时不得误报成会话问题。
  test("上游不可达返回 502", async () => {
    const { app } = setup(
      (recorded) => {
        if (recorded.path.startsWith("/api/passport/")) return loginOk();
        return new Response("asset", { status: 200 });
      },
      // 1 号端口在本机没有监听者，连接被立即拒绝（与会话用例同一手法）。
      { canvasUpstreamUrl: "http://127.0.0.1:1" },
    );

    const response = await call(app, `${CANVAS_PREFIX}/static/js/app.js`);

    expect(response.status).toBe(502);
  });

  // 存储域反代：目标 origin 取自上游签名直链，只允许 GET/HEAD、不带平台会话、剥离 Set-Cookie。
  test("存储域按签名直链的 origin 转发，只允许 GET/HEAD 且不带平台会话", async () => {
    const { app, requests } = setup((recorded) => {
      if (recorded.path.startsWith("/api/passport/")) return loginOk();
      if (recorded.path.startsWith("/api/workflow_api/sign_image_url")) {
        // 真实上游的扁平形状：`url` 在顶层（无 `data` 包装），见 `readStorageOrigin` 的注释。
        return new Response(JSON.stringify({ url: `${storageBaseUrl()}/opencoze/icon.png`, code: 0, msg: "" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    storageHandler = () =>
      new Response("png-bytes", {
        status: 200,
        headers: {
          "content-type": "image/png",
          "set-cookie": "minio-session=fixture; path=/",
        },
      });

    const response = await call(app, `${CANVAS_PREFIX}/storage/opencoze/icon.png?X-Amz-Signature=fixture`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("png-bytes");
    // 存储服务是另一个系统：预签名直链自带鉴权，平台会话不外发，上游 Set-Cookie 也不得进浏览器。
    expect(storageRequests).toHaveLength(1);
    expect(storageRequests[0]?.cookie).toBeNull();
    expect(storageRequests[0]?.path).toBe("/opencoze/icon.png?X-Amz-Signature=fixture");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'self'; frame-src 'self'");
    // 解析只发生一次：第二个请求直接复用已记住的 origin。
    await call(app, `${CANVAS_PREFIX}/storage/opencoze/icon.png?X-Amz-Signature=fixture`);
    expect(requests.filter((request) => request.path.startsWith("/api/workflow_api/sign_image_url"))).toHaveLength(1);
  });

  // 存储域的方法门：写请求一律 405，且不得触达存储服务。
  test("存储域的写方法返回 405 且不触达存储服务", async () => {
    const { app } = setup((recorded) => {
      if (recorded.path.startsWith("/api/passport/")) return loginOk();
      return new Response(JSON.stringify({ url: `${storageBaseUrl()}/opencoze/icon.png`, code: 0, msg: "" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const response = await call(app, `${CANVAS_PREFIX}/storage/opencoze/icon.png`, "POST");

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(storageRequests).toHaveLength(0);
  });

  // 存储域解析失败即 502 降级：画布内图片加载不出来，但错误文案不得回显上游原因。
  test("存储域解析失败返回 502 且不回显上游文案", async () => {
    const { app } = setup((recorded) => {
      if (recorded.path.startsWith("/api/passport/")) return loginOk();
      return new Response(JSON.stringify({ code: 777777775, msg: "Workflow operation failure: internal panic" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const response = await call(app, `${CANVAS_PREFIX}/storage/opencoze/icon.png`);

    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain("画布存储域不可用");
    expect(body).not.toContain("internal panic");
    expect(storageRequests).toHaveLength(0);
  });
});
