import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as net from "node:net";
import { accessSync, constants, existsSync } from "node:fs";
import { join } from "node:path";
import { createApiKey } from "../auth/api-key-service";
import { getBaseUrl } from "../config";
import { log } from "../logger";
import { storeGetEnvironment, storeCreateSession, storeListSessionsByEnvironment } from "../store";
import { closeInstanceLocalWs } from "../transport/acp-relay-handler";

export interface SpawnedInstance {
  id: string;
  userId: string;
  port: number;
  pid: number | null;
  status: "starting" | "running" | "stopped" | "error";
  command: string;
  error: string | null;
  apiKey: string;
  createdAt: Date;
  environmentId?: string;
  sessionId?: string;
}

const PORT_MIN = 8888;
const PORT_MAX = 8999;

const instances = new Map<string, SpawnedInstance>();
const allocatingPorts = new Set<number>();
let spawnImpl: typeof spawn = spawn;

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExecutable(command: string): string {
  const localBin = join(process.cwd(), "node_modules", ".bin", command);
  if (isExecutable(localBin)) {
    return localBin;
  }

  throw new Error(`Required executable not found: ${command}. Run npm install in the project root to install it into node_modules/.bin.`);
}

function allocatePort(): number | null {
  const occupied = new Set<number>();
  for (const inst of instances.values()) {
    occupied.add(inst.port);
  }
  for (const port of allocatingPorts) {
    occupied.add(port);
  }
  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    if (!occupied.has(port)) return port;
  }
  return null;
}

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

export async function spawnInstance(userId: string): Promise<SpawnedInstance> {
  const acpLinkPath = resolveExecutable("acp-link");

  // 1. Create dedicated API Key
  const { fullKey } = await createApiKey(userId, `instance-${Date.now()}`);
  const apiKey = fullKey;

  // 2. Allocate port (with concurrency guard)
  const port = allocatePort();
  if (!port) throw new Error("No available port");
  allocatingPorts.add(port);
  try {
    const available = await probePort(port);
    if (!available) throw new Error(`Port ${port} is in use`);

    // 3. Create SpawnedInstance record
    const id = `inst_${randomBytes(8).toString("hex")}`;
    const baseUrl = getBaseUrl();
    const command = `ACP_RCS_URL=${baseUrl} ACP_RCS_TOKEN=${apiKey} acp-link --group "${apiKey}" --port ${port} opencode -- acp`;
    const instance: SpawnedInstance = {
      id, userId, port, pid: null,
      status: "starting", command, error: null, apiKey,
      createdAt: new Date(),
    };
    instances.set(id, instance);

    // 4. Spawn child process
    const proc = spawnImpl(acpLinkPath, [
      "--group", apiKey,
      "--port", String(port),
      "opencode", "--", "acp",
    ], {
      env: { ...process.env, ACP_RCS_URL: baseUrl, ACP_RCS_TOKEN: apiKey },
      stdio: ["pipe", "ignore", "ignore"],
    });
    instance.pid = proc.pid ?? null;
    instance.status = "running";

    // 5. Listen to events
    proc.on("close", (code) => {
      instance.status = "stopped";
      if (code !== 0 && code !== null) {
        instance.error = `Process exited with code ${code}`;
      }
      allocatingPorts.delete(port);
    });
    proc.on("error", (err) => {
      instance.status = "error";
      instance.error = err.message;
      allocatingPorts.delete(port);
    });

    return instance;
  } catch (err) {
    allocatingPorts.delete(port);
    throw err;
  }
}

export function listInstances(userId: string): SpawnedInstance[] {
  return Array.from(instances.values()).filter(i => i.userId === userId);
}

export function findRunningInstanceByEnvironment(environmentId: string): SpawnedInstance | undefined {
  return Array.from(instances.values()).find(
    (i) => i.environmentId === environmentId && i.status !== "stopped" && i.status !== "error",
  );
}

export function getInstance(id: string): SpawnedInstance | undefined {
  return instances.get(id);
}

export function stopInstance(id: string, userId: string): { ok: boolean; error?: string } {
  const inst = instances.get(id);
  if (!inst) return { ok: false, error: "Instance not found" };
  if (inst.userId !== userId) return { ok: false, error: "Not your instance" };
  if (inst.status === "stopped") return { ok: false, error: "Already stopped" };

  // Close the shared local WS to acp-link before killing the process
  if (inst.environmentId) {
    closeInstanceLocalWs(inst.environmentId);
  }

  if (!inst.pid) { inst.status = "stopped"; return { ok: true }; }
  try {
    process.kill(inst.pid, "SIGTERM");
    setTimeout(() => {
      try { process.kill(inst.pid!, "SIGKILL"); } catch {}
    }, 5000);
    return { ok: true };
  } catch {
    inst.status = "stopped";
    return { ok: true };
  }
}

export function stopAllInstances(): void {
  for (const inst of instances.values()) {
    if (inst.pid && inst.status !== "stopped") {
      try { process.kill(inst.pid, "SIGTERM"); } catch {}
    }
  }
}

export async function spawnInstanceFromEnvironment(userId: string, environmentId: string): Promise<SpawnedInstance> {
  const acpLinkPath = resolveExecutable("acp-link");

  const env = storeGetEnvironment(environmentId);
  if (!env) throw new Error("Environment not found");
  if (env.userId !== userId) throw new Error("Not your environment");
  // Check if a running instance already exists for this environment
  const hasRunningInstance = Array.from(instances.values()).some(
    (i) => i.environmentId === environmentId && i.status !== "stopped" && i.status !== "error",
  );
  if (hasRunningInstance) throw new Error("Environment already has a running instance");

  // Eagerly create session so the frontend can navigate to it immediately
  let sessionId: string;
  const existing = storeListSessionsByEnvironment(environmentId);
  if (existing.length > 0) {
    sessionId = existing[0].id;
  } else {
    const session = storeCreateSession({
      environmentId,
      title: env.agentName || env.name,
      source: "acp",
      userId,
    });
    sessionId = session.id;
  }

  const cwd = env.workspacePath || env.directory;
  if (!cwd || !existsSync(cwd)) throw new Error(`Workspace directory does not exist: ${cwd}`);

  // Allocate port
  const port = allocatePort();
  if (!port) throw new Error("No available port");
  allocatingPorts.add(port);
  try {
    const available = await probePort(port);
    if (!available) throw new Error(`Port ${port} is in use`);

    const id = `inst_${randomBytes(8).toString("hex")}`;
    const command = `ACP_RCS_TOKEN=${env.secret} acp-link --group "${env.secret}" --port ${port} opencode -- acp`;
    const instance: SpawnedInstance = {
      id, userId, port, pid: null,
      status: "starting", command, error: null, apiKey: env.secret,
      createdAt: new Date(),
      environmentId,
      sessionId,
    };
    instances.set(id, instance);

    // Spawn acp-link as standalone local proxy (no RCS upstream URL).
    // Pass ACP_RCS_TOKEN so acp-link uses it as its local WS auth token.
    // The relay handler connects with this token to trigger agent spawning.
    const proc = spawnImpl(acpLinkPath, [
      "--group", env.secret,
      "--port", String(port),
      "opencode", "--", "acp",
    ], {
      env: { ...process.env, ACP_RCS_TOKEN: env.secret },
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    instance.pid = proc.pid ?? null;

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      log(`[instance:${id}] stdout: ${text}`);
      // Capture the auth token that acp-link generates for its local WS
      const match = text.match(/Token:\s*([a-f0-9]{64})/);
      if (match) {
        instance.apiKey = match[1];
        log(`[instance:${id}] Captured local WS token`);
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      log(`[instance:${id}] stderr: ${chunk.toString().trim()}`);
    });
    instance.status = "running";

    proc.on("close", (code) => {
      instance.status = "stopped";
      if (code !== 0 && code !== null) {
        instance.error = `Process exited with code ${code}`;
      }
      allocatingPorts.delete(port);
    });
    proc.on("error", (err) => {
      instance.status = "error";
      instance.error = err.message;
      allocatingPorts.delete(port);
    });

    return instance;
  } catch (err) {
    allocatingPorts.delete(port);
    throw err;
  }
}

export function setInstanceSpawnForTesting(fn: typeof spawn | null): void {
  spawnImpl = fn ?? spawn;
}
