import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setConfig } from "../config";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";

setConfig({ acpxGUrl: "http://localhost:8848" });

import Elysia from "elysia";
import { workflowApiApp, workflowStaticApp } from "../routes/web/workflow-proxy";

const originalFetch = globalThis.fetch;

function elysiaRequest(app: any, path: string, init?: RequestInit) {
  return app.handle(new Request(`http://localhost${path}`, init));
}

describe("Workflow Proxy", () => {
  beforeEach(() => {
    setTestAuth({
      user: { id: "test-user", email: "test@test.com", name: "Test" },
      authContext: { organizationId: "test-team", userId: "test-user", role: "owner" },
    });
    setTestOrgContext({ organizationId: "test-team", userId: "test-user", role: "owner" });
  });

  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
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
    expect(capturedInit.body).toBeDefined();
  });

  test("unauthenticated request returns 401", async () => {
    resetTestAuth();

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
