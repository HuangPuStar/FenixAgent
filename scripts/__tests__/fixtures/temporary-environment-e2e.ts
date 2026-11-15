import { resolve } from "node:path";

const script = resolve(import.meta.dir, "../../temporary-environments/e2e.ts");
type Fault =
  | "none"
  | "chat"
  | "expiry"
  | "restore"
  | "interrupt"
  | "leak"
  | "ttl"
  | "cleanup-interrupt"
  | "openai-memory"
  | "openai-handle"
  | "acp-session"
  | "acp-error"
  | "acp-close"
  | "stop-failure";

/** 只替代外部 HTTP 服务，运行真实 CLI、fetch、计时、断言和清理流程。 */
export function fixture(fault: Fault = "none", originalTtl: number | null = null) {
  const apiKey = crypto.randomUUID();
  let ttl = originalTtl;
  let ttlWrites = 0;
  let connectArrivals = 0;
  let releaseConnects!: () => void;
  const connectsReady = new Promise<void>((resolve) => {
    releaseConnects = resolve;
  });
  const memory = { acp: "", openai: "" };
  const turns = { acp: 0, openai: 0 };
  let sessionsCreated = 0;
  let activeRequests = 0;
  let peakRequests = 0;
  const rounds = new Map<number, Array<() => void>>();
  const arrive = (round: number, complete: () => void) => {
    activeRequests++;
    peakRequests = Math.max(peakRequests, activeRequests);
    const waiting = rounds.get(round) ?? [];
    waiting.push(() => {
      activeRequests--;
      complete();
    });
    rounds.set(round, waiting);
    if (waiting.length === 2) {
      rounds.delete(round);
      for (const release of waiting) release();
    }
  };
  const remember = (text: string) => text.match(/E2E_[AB]_[a-f0-9]{32}/)?.[0] ?? "";
  const instances = new Map<string, { environmentId: string; expiresAt: number; status: string }>();
  const files = new Map<string, Map<string, string>>();
  let markChat!: () => void;
  const chatting = new Promise<void>((resolve) => {
    markChat = resolve;
  });
  let markCleaning!: () => void;
  let finishCleaning!: () => void;
  const cleaning = new Promise<void>((resolve) => {
    markCleaning = resolve;
  });
  const cleanupGate = new Promise<void>((resolve) => {
    finishCleaning = resolve;
  });
  const policy = () => ({
    source: ttl === null ? "default" : "agent",
    ttlSeconds: ttl,
    effectiveTtlSeconds: ttl ?? 3600,
    maxTtlSeconds: 86400,
  });
  const ok = (data: unknown, status = 200) => Response.json({ success: true, data }, { status });
  const detail = (id: string) => {
    const row = instances.get(id);
    if (!row) throw new Error(`Unknown fixture instance ${id}`);
    if (row.expiresAt <= Date.now()) row.status = "stopped";
    return {
      instanceId: id,
      environmentId: row.environmentId,
      agentConfigId: "11111111-1111-4111-8111-111111111111",
      name: "api",
      creationSource: "api",
      isDefault: false,
      status: row.status,
      runtimeGeneration: 1,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
  };
  const sessionId = "ses_fixture_A";
  const httpSession = `fcs_${crypto.randomUUID()}`;
  const replacedHandle = `fcs_${crypto.randomUUID()}`;
  const server = Bun.serve<{ instanceId: string }>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${apiKey}`)
        return new Response("Unauthorized", { status: 401 });
      const url = new URL(request.url);
      const path = url.pathname.replace("/api/v1", "");
      const method = request.method;
      if (path.startsWith("/acp/relay/")) {
        if (url.searchParams.get("instanceId") !== "inst_1") return ok(null, 404);
        if (server.upgrade(request, { data: { instanceId: "inst_1" } })) return;
        return ok(null, 400);
      }
      if (path.endsWith("/environment-policy")) {
        if (method === "PUT") {
          if (fault === "ttl" && ++ttlWrites === 3) return ok(null, 503);
          ttl = ((await request.json()) as { ttlSeconds: number }).ttlSeconds;
        }
        if (method === "DELETE") {
          if (fault === "restore") return ok(null, 503);
          ttl = null;
          if (fault === "cleanup-interrupt") {
            markCleaning();
            await cleanupGate;
          }
          return ok(null);
        }
        return ok(policy());
      }
      if (path.startsWith("/agents/") && path.endsWith("/environments")) {
        const id = `inst_${instances.size + 1}`;
        const environmentId = `temp-${instances.size + 1}`;
        const expiresAt = Date.now() + (ttl ?? 3600) * 1000;
        instances.set(id, { environmentId, expiresAt, status: "stopped" });
        files.set(environmentId, new Map());
        return ok({ environmentId, instanceId: id, expiresAt: new Date(expiresAt).toISOString() }, 201);
      }
      if (path.endsWith("/instances/connect")) {
        const { instanceId } = (await request.json()) as { instanceId: string };
        const row = instances.get(instanceId);
        if (!row) return ok(null, 404);
        if (row.expiresAt <= Date.now() && fault !== "expiry")
          return Response.json({ success: false, error: { code: "ENVIRONMENT_EXPIRED" } }, { status: 410 });
        if (++connectArrivals >= 2) releaseConnects();
        await connectsReady;
        row.status = "running";
        return ok({
          ...detail(instanceId),
          relay: { wsUrl: `/acp/relay/${row.environmentId}?instanceId=${instanceId}` },
        });
      }
      if (path.startsWith("/agents/") && path.endsWith("/instances")) {
        const filter = url.searchParams.get("environmentType") ?? "regular";
        if (!["regular", "temporary", "all"].includes(filter)) return ok(null, 400);
        const items = filter === "regular" ? [] : [...instances.keys()].map(detail);
        return ok({
          items,
          total: items.length,
          page: Number(url.searchParams.get("page") ?? 1),
          pageSize: Number(url.searchParams.get("pageSize") ?? 100),
        });
      }
      if (path.startsWith("/instances/")) {
        const id = path.split("/")[2];
        const row = instances.get(id);
        if (!row) return ok(null, 404);
        if (path.endsWith("/stop")) {
          if (row.status !== "stopped") {
            row.status = "stopping";
            setTimeout(() => {
              row.status = fault === "stop-failure" ? "unknown" : "stopped";
            }, 25);
          }
          return ok(null, 202);
        }
        return ok(detail(id));
      }
      if (path.endsWith("/renew")) {
        const row = [...instances.values()].find((item) => item.environmentId === path.split("/")[2]);
        if (!row) return ok(null, 404);
        row.expiresAt = Date.now() + (ttl ?? 3600) * 1000;
        row.status = "running";
        return ok({
          instanceId: [...instances.keys()].find((id) => instances.get(id) === row),
          environmentId: row.environmentId,
          status: "running",
          expiresAt: new Date(row.expiresAt).toISOString(),
        });
      }
      if (path.includes("/workspace/files")) {
        const environmentId = path.split("/")[2];
        const stored = files.get(environmentId);
        if (!stored) return ok(null, 404);
        if (method === "POST") {
          const form = await request.formData();
          const file = form.get("files");
          if (!(file instanceof File)) return ok(null, 400);
          const name = `${form.get("path") ?? "user"}/${file.name}`;
          stored.set(name, await file.text());
          return ok({ environmentId, files: [{ name: file.name, path: name, size: file.size }] });
        }
        if (path.endsWith("/download"))
          return stored.has(url.searchParams.get("path") ?? "")
            ? new Response(stored.get(url.searchParams.get("path") ?? ""))
            : ok(null, 404);
        return ok({
          environmentId,
          paths: fault === "leak" ? [...files.values()].flatMap((items) => [...items.keys()]) : [...stored.keys()],
        });
      }
      if (path === "/chat/completions") {
        const id = request.headers.get("x-instance-id") ?? "";
        const row = instances.get(id);
        if (row && row.expiresAt <= Date.now())
          return Response.json({ error: { code: "ENVIRONMENT_EXPIRED" } }, { status: 410 });
        markChat();
        if (fault === "interrupt") return new Promise<Response>(() => {});
        if (fault === "chat" || fault === "restore")
          return Response.json({ error: { message: `upstream echoed ${apiKey}`, token: apiKey } }, { status: 503 });
        const body = (await request.json()) as { messages: Array<{ role: string; content: string }> };
        if (id !== "inst_2" || body.messages.length !== 1 || body.messages[0].role !== "user") return ok(null, 400);
        const round = ++turns.openai;
        if (round === 1) {
          memory.openai = remember(body.messages[0].content);
          if (!memory.openai || request.headers.has("x-session-id")) return ok(null, 400);
        } else if (
          request.headers.get("x-session-id") !== httpSession ||
          body.messages[0].content.includes(memory.openai)
        )
          return ok(null, 409);
        return new Promise<Response>((resolve) =>
          arrive(round, () =>
            resolve(
              Response.json(
                {
                  choices: [
                    {
                      message: {
                        role: "assistant",
                        content: fault === "openai-memory" && round === 2 ? memory.acp : memory.openai,
                      },
                    },
                  ],
                },
                {
                  headers: {
                    "X-Instance-Id": id,
                    "X-Session-Id": fault === "openai-handle" && round === 2 ? replacedHandle : httpSession,
                  },
                },
              ),
            ),
          ),
        );
      }
      return new Response(`Unhandled fixture request ${method} ${path}`, { status: 404 });
    },
    websocket: {
      open(socket) {
        socket.send(JSON.stringify({ type: "status", payload: { connected: true, capabilities: {} } }));
      },
      message(socket, raw) {
        const rpc = JSON.parse(raw.toString()) as {
          id: number;
          method: string;
          params: { sessionId?: string; content?: Array<{ text: string }> };
        };
        const error = (message: string) =>
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32603, message } }));
        if (rpc.method === "session/cancel") return;
        if (rpc.method === "session/new") {
          sessionsCreated++;
          socket.send(
            JSON.stringify({ type: "session_data", payload: { jsonrpc: "2.0", id: rpc.id, result: { sessionId } } }),
          );
          return;
        }
        if (rpc.method !== "session/prompt" || rpc.params.sessionId !== sessionId) {
          error("Unexpected ACP method/session");
          return;
        }
        if (fault === "acp-error") {
          error(`upstream echoed ${apiKey}`);
          return;
        }
        if (fault === "acp-close") {
          socket.close(1011, "fixture disconnect");
          return;
        }
        const round = ++turns.acp;
        const text = rpc.params.content?.map((part) => part.text).join("") ?? "";
        if (round === 1) {
          memory.acp = remember(text);
          if (!memory.acp) {
            error("Missing conversation marker");
            return;
          }
        } else if (text.includes(memory.acp)) {
          error("Second turn repeated first-turn marker");
          return;
        }
        arrive(round, () => {
          const update = {
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: fault === "acp-session" && round === 2 ? "ses_foreign" : sessionId,
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: memory.acp } },
            },
          };
          socket.send(JSON.stringify(round === 1 ? update : { type: "session_data", payload: update }));
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { stopReason: "end_turn" } }));
        });
      },
    },
  });
  const child = Bun.spawn([process.execPath, "run", script], {
    env: {
      ...process.env,
      FENIX_BASE_URL: server.url.origin,
      FENIX_USER_API_KEY: apiKey,
      FENIX_AGENT_ID: "11111111-1111-4111-8111-111111111111",
      TEMP_ENV_E2E_EXPIRY_SECONDS: "1",
      TEMP_ENV_E2E_TIMEOUT_MS: "3000",
      TEMP_ENV_E2E_STOP_GRACE_MS: "2000",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const result = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).then(
    ([exit, out, err]) => ({ exit, output: out + err }),
  );
  return {
    result,
    child,
    chatting,
    cleaning,
    finishCleaning,
    apiKey,
    handles: [httpSession, replacedHandle],
    instances,
    policy,
    conversation: () => ({ turns, peakRequests, sessionsCreated }),
    stop: () => {
      child.kill();
      server.stop(true);
    },
  };
}
