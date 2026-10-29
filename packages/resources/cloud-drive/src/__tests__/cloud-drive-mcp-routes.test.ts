import { describe, expect, test } from "bun:test";
import type { CloudDriveModuleConfig } from "../server/config";
import { createCloudDriveFacade } from "../server/facades/cloud-drive-facade";
import { issueCloudDriveMcpToken } from "../server/mcp/token";
import { createCloudDriveMcpRoutes } from "../server/routes/mcp/cloud-drive";
import { fakeGateway, makeFile } from "./cloud-drive-fixtures";

const SECRET = "mcp-test-secret";
const NOW = 1_700_000_000;
const BASE_URL = "http://localhost/mcp/cloud-drive";

function config(overrides: Partial<CloudDriveModuleConfig> = {}): CloudDriveModuleConfig {
  return {
    baseUrl: "http://127.0.0.1:8080",
    masterKey: "master-key-value",
    timeoutMs: 120_000,
    mcpTokenSecret: SECRET,
    mcpTokenTtlSeconds: 3600,
    mcpLaunchTtlSeconds: 86_400,
    mcpScope: "read",
    mcpTimeoutMs: 15_000,
    ...overrides,
  };
}

async function token(
  overrides: { scope?: "read" | "write"; ttlSeconds?: number; secret?: string; userId?: string } = {},
) {
  return issueCloudDriveMcpToken({
    userId: overrides.userId ?? "user-a",
    organizationId: "org-1",
    scope: overrides.scope ?? "read",
    ttlSeconds: overrides.ttlSeconds ?? 600,
    secret: overrides.secret ?? SECRET,
    nowSeconds: NOW,
  });
}

function createApp(
  options: {
    configOverride?: Partial<CloudDriveModuleConfig>;
    gateway?: Parameters<typeof fakeGateway>[0];
    nowSeconds?: () => number;
  } = {},
) {
  const gateway = fakeGateway(
    options.gateway ?? {
      listFiles: async () => ({ items: [makeFile()], nextCursor: null }),
    },
  );
  const facade = createCloudDriveFacade({ resolveGateway: () => gateway });
  return createCloudDriveMcpRoutes({
    facade,
    getConfig: () => config(options.configOverride),
    nowSeconds: options.nowSeconds ?? (() => NOW),
  });
}

function post(
  app: ReturnType<typeof createApp>,
  body: unknown,
  options: { token?: string; headers?: Record<string, string> } = {},
) {
  return app.handle(
    new Request(BASE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        ...options.headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("CloudDrive MCP 路由", () => {
  // 未携带 Bearer 一律 401，且不进入协议解析。
  test("缺少 token 返回 401", async () => {
    const response = await post(createApp(), { jsonrpc: "2.0", id: 1, method: "tools/list" });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  // 伪造签名与过期 token 都按无效凭据处理，不区分原因。
  test("invalid 或过期 token 返回 401", async () => {
    const app = createApp();
    const valid = await token();
    const [version, payload] = valid.split(".");
    const forged = `${version}.${payload}.${"A".repeat(43)}`;
    const expired = await token({ ttlSeconds: 60 });
    const later = createApp({ nowSeconds: () => NOW + 120 });

    expect((await post(app, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: forged })).status).toBe(401);
    expect((await post(later, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: expired })).status).toBe(401);
  });

  // 密钥或 CloudDrive 未配置时网关直接 503：部署问题不能伪装成凭据问题。
  test("未配置密钥或 CloudDrive 时返回 503", async () => {
    const tokens = await token();
    const cases: Array<Partial<CloudDriveModuleConfig>> = [
      { mcpTokenSecret: undefined },
      { baseUrl: undefined },
      { masterKey: undefined },
    ];

    for (const override of cases) {
      const response = await post(
        createApp({ configOverride: override }),
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { token: tokens },
      );
      expect(response.status).toBe(503);
    }
  });

  // stateless：initialize 返回协议版本与 instructions，不建立会话。
  test("initialize 返回 serverInfo 与安全 instructions", async () => {
    const response = await post(
      createApp(),
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "probe", version: "1.0.0" },
        },
      },
      { token: await token() },
    );
    const body = (await response.json()) as {
      result: { serverInfo: { name: string }; instructions: string; capabilities: unknown };
    };

    expect(response.status).toBe(200);
    expect(body.result.serverInfo.name).toBe("cloud-drive-mcp");
    expect(body.result.instructions).toContain("不可信数据");
  });

  // scope=read 的 tools/list 只有只读工具；scope=write 才有写工具。
  test("tools/list 按 token scope 过滤", async () => {
    const readBody = (await (
      await post(createApp(), { jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: await token() })
    ).json()) as { result: { tools: Array<{ name: string }> } };
    const writeBody = (await (
      await post(
        createApp(),
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { token: await token({ scope: "write" }) },
      )
    ).json()) as { result: { tools: Array<{ name: string }> } };

    expect(readBody.result.tools.map((tool) => tool.name)).toEqual([
      "cloud_drive_me",
      "cloud_drive_list",
      "cloud_drive_stat",
      "cloud_drive_search",
      "cloud_drive_read_markdown",
      "cloud_drive_versions",
      "cloud_drive_trash_list",
    ]);
    expect(writeBody.result.tools.map((tool) => tool.name)).toContain("cloud_drive_write_text");
  });

  // tools/call 只使用 token 派生主体；工具参数中的 uid 不能改变 subject。
  test("tools/call 使用 token 主体执行工具", async () => {
    const subjects: string[] = [];
    const app = createApp({
      gateway: {
        listFiles: async (subject) => {
          subjects.push(subject);
          return { items: [makeFile()], nextCursor: null };
        },
      },
    });

    const response = await post(
      app,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "cloud_drive_list", arguments: {} } },
      { token: await token({ userId: "user-a" }) },
    );
    const body = (await response.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };

    expect(subjects).toEqual(["user-a"]);
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content[0]?.text).toContain("report.txt");
  });

  // 越权字段由 SDK 的严格 schema 在工具执行前拒绝；错误里只出现键名，不回显调用方传值。
  test("tools/call 拒绝越权字段", async () => {
    const app = createApp();
    const response = await post(
      app,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "cloud_drive_list", arguments: { uid: "user-b" } },
      },
      { token: await token() },
    );
    const body = (await response.json()) as {
      error?: { code: number; message: string };
      result?: { isError?: boolean; content: Array<{ text: string }> };
    };
    const serialized = JSON.stringify(body);

    expect(body.error?.code === -32602 || body.result?.isError === true).toBe(true);
    expect(serialized).toContain("uid");
    expect(serialized).not.toContain("user-b");
  });

  // 未知工具名由 SDK 拒绝；不能落进任意业务分支。
  test("未知工具返回错误", async () => {
    const response = await post(
      createApp(),
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "cloud_drive_delete", arguments: {} } },
      { token: await token({ scope: "write" }) },
    );
    const body = (await response.json()) as { error?: { message: string }; result?: { isError?: boolean } };

    expect(body.error !== undefined || body.result?.isError === true).toBe(true);
  });

  // 请求体超过 2 MiB 直接 413，不进入 JSON-RPC 解析。
  test("超过 body 上限返回 413", async () => {
    const response = await createApp().handle(
      new Request(BASE_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await token()}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": String(2 * 1024 * 1024 + 1),
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(413);
  });

  // 工具调用的日志事件只含工具名、主体与结果，不含 token 或上游 body。
  test("工具调用结果不包含 token 与上游细节", async () => {
    const app = createApp({
      gateway: {
        getMe: async () => {
          throw new Error("internal upstream detail at http://drive.localhost");
        },
      },
    });
    const issued = await token();
    const response = await post(
      app,
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "cloud_drive_me", arguments: {} } },
      { token: issued },
    );
    const text = await response.text();

    expect(text).not.toContain(issued);
    expect(text).not.toContain("drive.localhost");
    expect(text).not.toContain("master-key-value");
  });

  // GET 请求（SSE 流）在 stateless + JSONResponse 下必须得到明确状态，而不是挂起。
  test("GET 请求返回 SDK 的明确状态", async () => {
    const response = await createApp().handle(
      new Request(BASE_URL, { method: "GET", headers: { authorization: `Bearer ${await token()}` } }),
    );

    expect([405, 400, 406]).toContain(response.status);
  });
});
