import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentConfig, environment, team, user } from "../db/schema";
import { runAgentTask } from "../services/agent-task-runner";

const TEST_USER_ID = "user_agent_runner_test";
const TEST_ENV_ID = "env_agent_runner_test";
let TEST_TEAM_ID = "";
let TEST_AC_ID = "";

let workspaceRoot = "";
let toolDir = "";
let originalPath = process.env.PATH ?? "";

async function upsertUser() {
  const existing = await db.select().from(user).where(eq(user.id, TEST_USER_ID)).limit(1);
  if (existing.length > 0) return;
  const now = new Date();
  await db.insert(user).values({
    id: TEST_USER_ID,
    name: "Runner Test",
    email: "runner-test@rcs.local",
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  });
}

async function ensureTeam() {
  if (TEST_TEAM_ID) return;
  const now = new Date();
  const [t] = await db.insert(team).values({
    name: "runner-team",
    slug: `runner-team-${Date.now()}`,
    createdBy: TEST_USER_ID,
    createdAt: now,
    updatedAt: now,
  }).returning();
  TEST_TEAM_ID = t.id;
}

async function ensureAgentConfig(name: string) {
  if (TEST_AC_ID) return;
  const now = new Date();
  const [ac] = await db.insert(agentConfig).values({
    name,
    teamId: TEST_TEAM_ID,
    userId: TEST_USER_ID,
  }).returning();
  TEST_AC_ID = ac.id;
}

async function upsertEnvironment(agentConfigId: string | null) {
  const now = new Date();
  const existing = await db.select().from(environment).where(eq(environment.id, TEST_ENV_ID)).limit(1);
  if (existing.length > 0) {
    await db.update(environment).set({
      workspacePath: workspaceRoot,
      agentConfigId,
      updatedAt: now,
    }).where(eq(environment.id, TEST_ENV_ID));
    return;
  }

  await db.insert(environment).values({
    id: TEST_ENV_ID,
    name: "runner-env",
    description: null,
    workspacePath: workspaceRoot,
    agentConfigId,
    status: "idle",
    machineName: null,
    branch: null,
    gitRepoUrl: null,
    maxSessions: 1,
    workerType: "acp",
    capabilities: null,
    secret: "runner-secret",
    userId: TEST_USER_ID,
    teamId: TEST_TEAM_ID,
    lastPollAt: null,
    createdAt: now,
    updatedAt: now,
  });
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
    await upsertUser();
    await ensureTeam();
    await ensureAgentConfig("agent-alpha");
    await upsertEnvironment(TEST_AC_ID);
  });

  afterAll(async () => {
    process.env.PATH = originalPath;
    try { await db.delete(environment).where(eq(environment.id, TEST_ENV_ID)); } catch {}
    try { await db.delete(agentConfig).where(eq(agentConfig.id, TEST_AC_ID)); } catch {}
    try { await db.delete(team).where(eq(team.id, TEST_TEAM_ID)); } catch {}
    try { await db.delete(user).where(eq(user.id, TEST_USER_ID)); } catch {}
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
    await db.delete(environment).where(eq(environment.id, TEST_ENV_ID));

    await expect(runAgentTask({
      userId: TEST_USER_ID,
      environmentId: TEST_ENV_ID,
      taskId: "task-missing-env",
      taskText: "list files",
      timeoutMinutes: 1,
      logId: "log-missing",
    })).rejects.toThrow("Environment not found");
  });

  it("writes an empty config when environment has no agent config", async () => {
    await upsertEnvironment(null);

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
