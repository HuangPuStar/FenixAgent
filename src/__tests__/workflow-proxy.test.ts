import { describe, expect, mock, test, beforeEach, afterEach } from "bun:test";

// Mock config before any imports that use it
mock.module("../config", () => ({
  config: {
    port: 3000,
    host: "0.0.0.0",
    apiKeys: [],
    baseUrl: "http://localhost:3000",
    pollTimeout: 8,
    heartbeatInterval: 20,
    wsIdleTimeout: 255,
    wsKeepaliveInterval: 20,
    disconnectTimeout: 120,
    jwtExpiresIn: 3600,
    acpxGUrl: "http://localhost:8848",
  },
  getBaseUrl: () => "http://localhost:3000",
}));

// Mock better-auth so sessionAuth (which dynamically imports it) returns a valid session
let authenticated = true;
mock.module("../auth/better-auth", () => ({
  auth: {
    api: {
      getSession: async () => {
        if (!authenticated) return null;
        return {
          user: { id: "test-user", email: "test@test.com", name: "Test" },
          session: { id: "sess_test", userId: "test-user", token: "tok" },
        };
      },
    },
  },
}));

import { Hono } from "hono";
import { workflowStaticApp, workflowApiApp } from "../routes/web/workflow-proxy";

// Save original fetch
const originalFetch = globalThis.fetch;

describe("Workflow Proxy", () => {
  beforeEach(() => {
    authenticated = true;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("static proxy: GET /workflow-ui/style.css forwards to acpx-g /style.css", async () => {
    const fakeResponse = new Response("body{color:red}", {
      status: 200,
      headers: { "Content-Type": "text/css" },
    });
    globalThis.fetch = mock(async (url: any) => {
      expect(url.toString()).toContain("localhost:8848/style.css");
      return fakeResponse;
    }) as any;

    const app = new Hono();
    app.route("/workflow-ui", workflowStaticApp);
    const res = await app.request("/workflow-ui/style.css");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("body{color:red}");
  });

  test("API proxy: GET /api/v1/workflows forwards to acpx-g /api/v1/workflows", async () => {
    const fakeResponse = new Response(JSON.stringify({ workflows: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    globalThis.fetch = mock(async (url: any) => {
      expect(url.toString()).toContain("localhost:8848/api/v1/workflows");
      return fakeResponse;
    }) as any;

    const app = new Hono();
    app.route("/api/v1", workflowApiApp);
    const res = await app.request("/api/v1/workflows");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ workflows: [] });
  });

  test("POST request transparently forwards body", async () => {
    const fakeResponse = new Response(JSON.stringify({ id: "wf_1" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
    let capturedInit: any = null;
    globalThis.fetch = mock(async (url: any, init: any) => {
      expect(url.toString()).toContain("localhost:8848/api/v1/workflows");
      expect(init.method).toBe("POST");
      capturedInit = init;
      return fakeResponse;
    }) as any;

    const app = new Hono();
    app.route("/api/v1", workflowApiApp);
    const res = await app.request("/api/v1/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test-workflow" }),
    });
    expect(res.status).toBe(201);
    // Body is forwarded as ReadableStream (request.body)
    expect(capturedInit.body).toBeDefined();
  });

  test("unauthenticated request returns 401", async () => {
    authenticated = false;

    const app = new Hono();
    app.route("/workflow-ui", workflowStaticApp);
    const res1 = await app.request("/workflow-ui/");
    expect(res1.status).toBe(401);

    const app2 = new Hono();
    app2.route("/api/v1", workflowApiApp);
    const res2 = await app2.request("/api/v1/workflows");
    expect(res2.status).toBe(401);
  });

  test("acpx-g unreachable returns 502 with JSON error", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as any;

    const app = new Hono();
    app.route("/workflow-ui", workflowStaticApp);
    const res = await app.request("/workflow-ui/");
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error.type).toBe("bad_gateway");
    expect(data.error.message).toContain("acpx-g unreachable");
  });
});
