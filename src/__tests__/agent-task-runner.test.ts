import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { environment, user } from "../db/schema";
import { runAgentTask } from "../services/agent-task-runner";

const TEST_USER_ID = "user_agent_runner_test";
const TEST_ENV_ID = "env_agent_runner_test";

let workspaceRoot = "";
let toolDir = "";
let originalPath = process.env.PATH ?? "";

function upsertUser() {
  const existing = db.select().from(user).where(eq(user.id, TEST_USER_ID)).limit(1).all();
  if (existing.length > 0) return;
  const now = new Date();
  db.insert(user).values({
    id: TEST_USER_ID,
    name: "Runner Test",
    email: "runner-test@rcs.local",
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  }).run();
}

function upsertEnvironment(agentName: string | null) {
  const now = new Date();
  const existing = db.select().from(environment).where(eq(environment.id, TEST_ENV_ID)).limit(1).all();
  if (existing.length > 0) {
    db.update(environment).set({
      workspacePath: workspaceRoot,
      agentName,
      updatedAt: now,
    }).where(eq(environment.id, TEST_ENV_ID)).run();
    return;
  }

  db.insert(environment).values({
    id: TEST_ENV_ID,
    name: "runner-env",
    description: null,
    workspacePath: workspaceRoot,
    agentName,
    status: "idle",
    machineName: null,
    branch: null,
    gitRepoUrl: null,
    maxSessions: 1,
    workerType: "acp",
    capabilities: null,
    secret: "runner-secret",
    userId: TEST_USER_ID,
    lastPollAt: null,
    createdAt: now,
    updatedAt: now,
  }).run();
}

async function createFakeOpencode() {
  toolDir = await mkdtemp(join(tmpdir(), "agent-task-runner-bin-"));
  const scriptPath = join(toolDir, "opencode");
  const script = `#!/bin/sh
mode="$1"
task_text="$2"

if [ "$mode" != "run" ]; then
  echo "unexpected mode: $mode" >&2
  exit 2
fi

if [ "$task_text" = "list files" ]; then
  printf 'line 1\\nline 2\\n'
  exit 0
fi

if [ "$task_text" = "sleep forever" ]; then
  echo "still running" >&2
  trap 'echo "still running" >&2; exit 0' TERM
  while true; do
    sleep 1
  done
fi

if [ "$task_text" = "pwd" ]; then
  exit 0
fi

echo "unhandled task: $task_text" >&2
exit 1
`;

  await writeFile(scriptPath, script, "utf8");
  await chmod(scriptPath, 0o755);
  process.env.PATH = `${toolDir}:${originalPath}`;
}

describe("agent-task-runner", () => {
  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "agent-task-runner-workspace-"));
    originalPath = process.env.PATH ?? "";
    await createFakeOpencode();
    upsertUser();
    upsertEnvironment("agent-alpha");
  });

  afterAll(async () => {
    process.env.PATH = originalPath;
    try { db.delete(environment).where(eq(environment.id, TEST_ENV_ID)).run(); } catch {}
    try { db.delete(user).where(eq(user.id, TEST_USER_ID)).run(); } catch {}
    if (workspaceRoot) {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
    if (toolDir) {
      await rm(toolDir, { recursive: true, force: true });
    }
  });

  it("returns success and writes .opencode/config.json", async () => {
    const result = await runAgentTask({
      userId: TEST_USER_ID,
      environmentId: TEST_ENV_ID,
      taskId: "task-success",
      taskText: "list files",
      timeoutMinutes: 1,
      logId: "log-success",
    });

    const configPath = join(result.workspacePath, ".opencode", "config.json");
    const configContent = await readFile(configPath, "utf8");

    expect(result.status).toBe("success");
    expect(result.workspacePath).toContain(".scheduled-runs/task-success/");
    expect(result.resultSummary).toBe("line 1\nline 2");
    expect(configContent).toContain('"default_agent": "agent-alpha"');
  });

  it("returns timeout when the child process exceeds the timeout", async () => {
    const result = await runAgentTask({
      userId: TEST_USER_ID,
      environmentId: TEST_ENV_ID,
      taskId: "task-timeout",
      taskText: "sleep forever",
      timeoutMinutes: 0.00002,
      logId: "log-timeout",
    });

    expect(result.status).toBe("timeout");
    expect(result.error).toBe("Task execution timed out");
    expect(result.workspacePath).toContain(".scheduled-runs/task-timeout/");
  });

  it("throws when the environment does not exist", async () => {
    db.delete(environment).where(eq(environment.id, TEST_ENV_ID)).run();

    await expect(runAgentTask({
      userId: TEST_USER_ID,
      environmentId: TEST_ENV_ID,
      taskId: "task-missing-env",
      taskText: "list files",
      timeoutMinutes: 1,
      logId: "log-missing",
    })).rejects.toThrow("Environment not found");
  });

  it("writes an empty config when environment has no agent name", async () => {
    upsertEnvironment(null);

    const result = await runAgentTask({
      userId: TEST_USER_ID,
      environmentId: TEST_ENV_ID,
      taskId: "task-no-agent",
      taskText: "pwd",
      timeoutMinutes: 1,
      logId: "log-no-agent",
    });

    const configPath = join(result.workspacePath, ".opencode", "config.json");
    const configContent = await readFile(configPath, "utf8");
    expect(configContent.trim()).toBe("{}");
  });
});
