import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { environmentRepo } from "../repositories/environment";
import { getAgentConfigById } from "./config-pg";
import { resolveExecutable } from "../utils/executable";

const SUMMARY_LIMIT = 2000;

export interface RunAgentTaskInput {
  userId: string;
  environmentId: string;
  taskId: string;
  taskText: string;
  timeoutMinutes: number;
  logId: string;
}

export interface AgentTaskRunResult {
  status: "success" | "failed" | "timeout";
  workspacePath: string;
  workspaceName: string;
  resultSummary: string | null;
  error: string | null;
  duration: number;
}

function formatRunTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function buildRunWorkspacePath(baseWorkspacePath: string, taskId: string, logId: string, now = new Date()): string {
  return join(baseWorkspacePath, ".scheduled-runs", taskId, `${formatRunTimestamp(now)}-${logId}`);
}

function summarizeOutput(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > SUMMARY_LIMIT ? trimmed.slice(-SUMMARY_LIMIT) : trimmed;
}

export async function runAgentTask(input: RunAgentTaskInput): Promise<AgentTaskRunResult> {
  const env = await environmentRepo.getById(input.environmentId);
  if (!env || env.userId !== input.userId) {
    throw new Error("Environment not found");
  }

  const runDir = buildRunWorkspacePath(env.workspacePath, input.taskId, input.logId);
  const opencodeConfigDir = join(runDir, ".opencode");
  const workspaceName = basename(runDir);

  let defaultAgent = env.agentName;
  if (!defaultAgent && env.agentConfigId) {
    const agentConfig = await getAgentConfigById(env.agentConfigId);
    defaultAgent = agentConfig?.name ?? null;
  }
  const config = defaultAgent ? { default_agent: defaultAgent } : {};

  await mkdir(runDir, { recursive: true });
  await mkdir(opencodeConfigDir, { recursive: true });
  await writeFile(join(opencodeConfigDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);

  const opencodePath = resolveExecutable("opencode");
  const startedAt = Date.now();

  return await new Promise<AgentTaskRunResult>((resolve, reject) => {
    const proc = spawn(opencodePath, ["run", input.taskText], {
      cwd: runDir,
      env: { ...process.env, OPENCODE_DISABLE_TELEMETRY: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const clearTimers = (timers: NodeJS.Timeout[]) => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, input.timeoutMinutes * 60_000);

    const killHandle = setTimeout(() => {
      if (timedOut) {
        proc.kill("SIGKILL");
      }
    }, input.timeoutMinutes * 60_000 + 5_000);

    const finalize = (status: AgentTaskRunResult["status"], error: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers([timeoutHandle, killHandle]);
      const duration = Date.now() - startedAt;
      const summarySource = status === "success" ? stdout : stderr || stdout;
      resolve({
        status,
        workspacePath: runDir,
        workspaceName,
        resultSummary: summarizeOutput(summarySource),
        error,
        duration,
      });
    };

    proc.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    proc.on("error", (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers([timeoutHandle, killHandle]);
      reject(error);
    });
    proc.on("close", (exitCode: number | null) => {
      if (timedOut) {
        finalize("timeout", "Task execution timed out");
        return;
      }
      if (exitCode === 0) {
        finalize("success", null);
        return;
      }
      finalize("failed", stderr.trim() || "Task execution failed");
    });
  });
}
