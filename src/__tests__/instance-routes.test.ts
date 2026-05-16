import { describe, test, expect, beforeEach, mock } from "bun:test";
import Elysia from "elysia";

// Inline the toResponse logic from instances.ts
function toResponse(inst: any) {
  return {
    id: inst.id,
    port: inst.port,
    status: inst.status,
    error: inst.error,
    group_id: inst.apiKey,
    instance_number: inst.instanceNumber,
    created_at: Math.floor(inst.createdAt.getTime() / 1000),
  };
}

// Mock service functions
const mockSpawnInstance = mock<(userId: string) => Promise<{
  id: string;
  userId: string;
  port: number;
  pid: number;
  status: "running";
  command: string;
  error: null;
  apiKey: string;
  createdAt: Date;
  instanceNumber: number;
}>>(async (userId: string) => ({
  id: "inst_abc123",
  userId,
  port: 8888,
  pid: 12345,
  status: "running" as const,
  command: "acp-link ...",
  error: null,
  apiKey: "rcs_test_api_key",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  instanceNumber: 1,
}));

const mockListInstances = mock<(userId: string) => Array<{
  id: string;
  userId: string;
  port: number;
  pid: number;
  status: "running" | "stopped";
  command: string;
  error: null;
  apiKey: string;
  createdAt: Date;
  instanceNumber: number;
}>>((_userId: string) => [
  {
    id: "inst_abc123",
    userId: "test-user-id",
    port: 8888,
    pid: 12345,
    status: "running" as const,
    command: "acp-link ...",
    error: null,
    apiKey: "rcs_test_api_key",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    instanceNumber: 1,
  },
  {
    id: "inst_def456",
    userId: "test-user-id",
    port: 8889,
    pid: 12346,
    status: "stopped" as const,
    command: "acp-link ...",
    error: null,
    apiKey: "rcs_test_api_key2",
    createdAt: new Date("2026-01-02T00:00:00Z"),
    instanceNumber: 2,
  },
]);

type StopInstanceResult =
  | { ok: true }
  | { ok: false; error: "Instance not found" | "Not your instance" | string };

const mockStopInstance = mock<(id: string, userId: string) => Promise<StopInstanceResult>>(async () => ({ ok: true }));

function request(app: Elysia, path: string, init?: RequestInit) {
  return app.handle(new Request(`http://localhost${path}`, init));
}

// Build the route inline with mock auth
function createInstanceApp() {
  const app = new Elysia()
    .state({ user: null as { id: string } | null })
    .onBeforeHandle(({ store }) => {
      store.user = { id: "test-user-id" };
    });

  app.post("/web/instances", async ({ store }) => {
    const user = store.user!;
    try {
      const inst = await mockSpawnInstance(user.id);
      return new Response(JSON.stringify(toResponse(inst)), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err: any) {
      return new Response(JSON.stringify({ error: { type: "spawn_failed", message: err.message } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  });

  app.get("/web/instances", ({ store }) => {
    const user = store.user!;
    const insts = mockListInstances(user.id);
    return insts.map(toResponse);
  });

  app.delete("/web/instances/:id", async ({ store, params }) => {
    const user = store.user!;
    const id = params.id;
    const result = await mockStopInstance(id, user.id);
    if (!result.ok) {
      const statusCode = result.error === "Instance not found" ? 404
        : result.error === "Not your instance" ? 403
        : 400;
      return new Response(JSON.stringify({ error: { type: "bad_request", message: result.error } }), {
        status: statusCode,
        headers: { "Content-Type": "application/json" },
      });
    }
    return { ok: true };
  });

  return app;
}

describe("Instance Routes", () => {
  let app: any;

  beforeEach(() => {
    mockSpawnInstance.mockClear();
    mockListInstances.mockClear();
    mockStopInstance.mockClear();
    app = createInstanceApp();
  });

  test("POST /web/instances — creates instance successfully", async () => {
    const res = await request(app, "/web/instances", { method: "POST" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe("inst_abc123");
    expect(body.port).toBe(8888);
    expect(body.status).toBe("running");
    expect(body.created_at).toBeTruthy();
    expect(mockSpawnInstance).toHaveBeenCalledTimes(1);
  });

  test("POST /web/instances — spawn failure returns 500", async () => {
    mockSpawnInstance.mockRejectedValueOnce(new Error("No available port"));

    const res = await request(app, "/web/instances", { method: "POST" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.type).toBe("spawn_failed");
    expect(body.error.message).toBe("No available port");
  });

  test("GET /web/instances — lists user instances", async () => {
    const res = await request(app, "/web/instances");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe("inst_abc123");
    expect(body[1].id).toBe("inst_def456");
    expect(mockListInstances).toHaveBeenCalledWith("test-user-id");
  });

  test("GET /web/instances — returns empty array when no instances", async () => {
    mockListInstances.mockReturnValueOnce([]);

    const res = await request(app, "/web/instances");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  test("DELETE /web/instances/:id — stops instance successfully", async () => {
    const res = await request(app, "/web/instances/inst_abc123", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockStopInstance).toHaveBeenCalledWith("inst_abc123", "test-user-id");
  });

  test("DELETE /web/instances/:id — returns 404 for not found", async () => {
    mockStopInstance.mockResolvedValueOnce({ ok: false, error: "Instance not found" });

    const res = await request(app, "/web/instances/inst_nonexistent", { method: "DELETE" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.type).toBe("bad_request");
  });

  test("DELETE /web/instances/:id — returns 403 for non-owner", async () => {
    mockStopInstance.mockResolvedValueOnce({ ok: false, error: "Not your instance" });

    const res = await request(app, "/web/instances/inst_other", { method: "DELETE" });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toBe("Not your instance");
  });

  test("POST /web/instances — response includes instance_number", async () => {
    const res = await request(app, "/web/instances", { method: "POST" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.instance_number).toBe(1);
  });

  test("GET /web/instances — each item includes instance_number", async () => {
    const res = await request(app, "/web/instances");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].instance_number).toBe(1);
    expect(body[1].instance_number).toBe(2);
  });
});
