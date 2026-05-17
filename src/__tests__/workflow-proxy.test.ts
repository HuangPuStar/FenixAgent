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

// Mock better-auth so sessionAuth returns a valid session
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

mock.module("../services/team", () => ({
  getAuthContext: async () => ({ teamId: "test-team", userId: "test-user", role: "owner" }),
    getAuthContextByTeamId: async () => ({ teamId: "test-team", userId: "test-user", role: "owner" }),
  ensurePersonalTeam: async () => {},
  listMyTeams: async () => [{ id: "test-team", name: "Test Team", slug: "test-team" }],
  getTeamDetail: async () => null,
  createTeam: async () => null,
  switchTeam: async () => null,
  addMember: async () => {},
  removeMember: async () => false,
  updateRole: async () => false,
  getTeamMembers: async () => [],
  updateTeam: async () => false,
  deleteTeam: async () => false,
}));

import Elysia from "elysia";
import { workflowStaticApp, workflowApiApp } from "../routes/web/workflow-proxy";

// Save original fetch
const originalFetch = globalThis.fetch;

function elysiaRequest(app: any, path: string, init?: RequestInit) {
  return app.handle(new Request(`http://localhost${path}`, init));
}

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

    const app = new Elysia().use(workflowStaticApp);
    const res = await elysiaRequest(app, "/workflow-ui/style.css");
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

    const app = new Elysia().use(workflowApiApp);
    const res = await elysiaRequest(app, "/api/v1/workflows");
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

    const app = new Elysia().use(workflowApiApp);
    const res = await elysiaRequest(app, "/api/v1/workflows", {
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

    const app = new Elysia().use(workflowStaticApp);
    const res1 = await elysiaRequest(app, "/workflow-ui/");
    expect(res1.status).toBe(401);

    const app2 = new Elysia().use(workflowApiApp);
    const res2 = await elysiaRequest(app2, "/api/v1/workflows");
    expect(res2.status).toBe(401);
  });

  test("acpx-g unreachable returns 502 with JSON error", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as any;

    const app = new Elysia().use(workflowStaticApp);
    const res = await elysiaRequest(app, "/workflow-ui/");
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error.type).toBe("bad_gateway");
    expect(data.error.message).toContain("acpx-g unreachable");
  });
});
