import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCcbHandler } from "@fenix/ccb";
import { createOpencodeHandler } from "@fenix/opencode";
import { createPeriHandler } from "@fenix/peri";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { createAcpSessionState } from "../acp-session-state.js";
import type { EngineHandler, EngineStartContext } from "../client/instance-manager.js";

const FIXTURE = join(import.meta.dir, "fixtures", "remote-death-agent.mjs");
const TEST_TIMEOUT_MS = 20_000;

type RuntimeState = EngineStartContext["state"];
type SentFrame = Record<string, unknown>;

interface EngineCase {
  name: string;
  create: () => EngineHandler;
}

const engines: EngineCase[] = [
  { name: "peri", create: () => createPeriHandler(process.execPath, [FIXTURE]) },
  { name: "opencode", create: () => createOpencodeHandler(process.execPath, [FIXTURE]) },
  { name: "ccb", create: () => createCcbHandler(process.execPath, [FIXTURE]) },
];

const workspaces: string[] = [];

afterEach(async () => {
  for (const dir of workspaces.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "remote-death-"));
  workspaces.push(dir);
  return dir;
}

function createState(workspace: string, generation: number, env: Record<string, string> = {}): RuntimeState {
  const launchSpec: AgentLaunchSpec = {
    organizationId: "org",
    userId: "user",
    env,
    agent: { name: "agent", prompt: "" },
    model: { provider: "test", protocol: "openai", model: "test" },
    skills: [],
    mcpServers: [],
  };
  return {
    instanceId: "inst_remote_death",
    launchSpec,
    workspace,
    process: null,
    connection: null,
    capabilities: null,
    sessionState: createAcpSessionState(),
    dispatcher: null,
    agentType: "peri",
    sessionId: "rcs_remote_death",
    runtimeGeneration: generation,
    serverEpoch: "epoch_remote_death",
  };
}

async function startEngine(engine: EngineCase, state: RuntimeState): Promise<SentFrame[]> {
  const sent: SentFrame[] = [];
  const handler = engine.create();
  await handler.startInstance({
    state,
    instanceId: state.instanceId,
    send: (message) => {
      sent.push(message as SentFrame);
    },
  });
  return sent;
}

function statusFrames(sent: SentFrame[], connected: boolean): Array<Record<string, unknown>> {
  return sent
    .filter((message) => message.type === "status")
    .map((message) => message.payload as Record<string, unknown>)
    .filter((payload) => payload?.connected === connected);
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForExit(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const events = proc as unknown as Pick<EventEmitter, "once">;
  await new Promise<void>((resolve) => {
    events.once("exit", () => resolve());
  });
}

/** 对已退出进程重放 exit：真实 ChildProcess 仍是 EventEmitter，用于覆盖重复/迟到信号。 */
function emitLateExit(proc: ChildProcess): void {
  const events = proc as unknown as { emit(event: string, code: number | null, signal: string | null): boolean };
  events.emit("exit", 0, null);
}

async function killProcess(proc: ChildProcess): Promise<void> {
  proc.kill("SIGKILL");
  await waitForExit(proc);
}

function assertDisconnectedState(state: RuntimeState): void {
  expect(state.process).toBeNull();
  expect(state.connection).toBeNull();
  expect(state.capabilities).toBeNull();
  expect(state.dispatcher).toBeNull();
  expect(state.sessionState.connection).toBeNull();
  expect(state.sessionState.agentCapabilities).toBeNull();
  expect(state.sessionState.promptCapabilities).toBeNull();
  expect(state.sessionState.sessionId).toBeNull();
}

for (const engine of engines) {
  describe(`${engine.name} 远端 Agent 失联`, () => {
    // 执行中死亡：清空死连接并只广播一次 connected:false，新一代替换后恢复 connected:true。
    test(
      "执行中死亡只广播一次失联且新进程可恢复",
      async () => {
        const workspace = await makeWorkspace();
        const state = createState(workspace, 1);
        const sent = await startEngine(engine, state);
        const dispatcher = state.dispatcher;
        expect(dispatcher).not.toBeNull();
        const proc = state.process as ChildProcess;
        const pid = proc.pid as number;

        await dispatcher?.handleMessage({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
        await waitFor(
          () => sent.some((message) => message.id === 1 && message.result !== undefined),
          "session/new 响应",
        );

        const prompt = dispatcher?.handleMessage({
          jsonrpc: "2.0",
          id: 2,
          method: "session/prompt",
          params: { sessionId: "ses_fixture", content: [{ type: "text", text: "run" }] },
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        await killProcess(proc);
        await prompt;
        await waitFor(() => state.process === null, "失联收口");

        assertDisconnectedState(state);
        const lost = statusFrames(sent, false);
        expect(lost).toHaveLength(1);
        expect(lost[0]?.agentPid).toBe(pid);
        expect(lost[0]?.runtimeGeneration).toBe(1);
        // 在途 prompt 必须收敛为明确失败，不得被当作成功或静默挂起。
        expect(sent.some((message) => message.id === 2 && message.error !== undefined)).toBe(true);

        // 旧 dispatcher 不得把死连接再次宣告为已连接。
        await dispatcher?.handleMessage({ type: "connect" });
        expect(statusFrames(sent, true)).toHaveLength(0);

        const nextState = createState(workspace, 2);
        const nextSent = await startEngine(engine, nextState);
        // 新进程 ready 之前不得报告 connected:true。
        expect(statusFrames(nextSent, true)).toHaveLength(0);
        await nextState.dispatcher?.handleMessage({ type: "connect" });
        const ready = statusFrames(nextSent, true);
        expect(ready).toHaveLength(1);
        expect(ready[0]?.connected).toBe(true);

        // 旧进程迟到的 exit 不得清理新进程，也不得重复广播。
        emitLateExit(proc);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(nextState.process).not.toBeNull();
        expect(nextState.sessionState.connection).not.toBeNull();
        expect(nextState.dispatcher).not.toBeNull();
        expect(statusFrames(nextSent, false)).toHaveLength(0);
        expect(statusFrames(sent, false)).toHaveLength(1);

        await killProcess(nextState.process as ChildProcess);
      },
      TEST_TIMEOUT_MS,
    );

    // 空闲死亡：没有在途请求时同样清空 dispatcher 会话状态，避免后续 connect 回报假在线。
    test(
      "空闲死亡后 dispatcher 不再回报 connected:true",
      async () => {
        const workspace = await makeWorkspace();
        const state = createState(workspace, 3);
        const sent = await startEngine(engine, state);
        const dispatcher = state.dispatcher;
        const proc = state.process as ChildProcess;

        await killProcess(proc);
        await waitFor(() => state.process === null, "空闲失联收口");

        assertDisconnectedState(state);
        expect(statusFrames(sent, false)).toHaveLength(1);
        await dispatcher?.handleMessage({ type: "connect" });
        expect(statusFrames(sent, true)).toHaveLength(0);
      },
      TEST_TIMEOUT_MS,
    );

    // stdout EOF：进程仍存活但流已关闭，必须走同一条失联收口而不是等进程退出。
    test(
      "stdout EOF 触发失联收口且进程仍存活",
      async () => {
        const workspace = await makeWorkspace();
        const state = createState(workspace, 4);
        const sent = await startEngine(engine, state);
        const proc = state.process as ChildProcess;

        // 父进程侧结束可读流：等价于远端 stdout 已 EOF，而子进程本身仍然存活。
        proc.stdout?.push(null);
        await waitFor(() => state.process === null, "stdout EOF 收口");
        expect(proc.exitCode).toBeNull();
        expect(proc.signalCode).toBeNull();
        assertDisconnectedState(state);
        const lost = statusFrames(sent, false);
        expect(lost).toHaveLength(1);
        expect(lost[0]?.agentPid).toBe(proc.pid);

        await killProcess(proc);
      },
      TEST_TIMEOUT_MS,
    );

    // 重复死亡：exit 与 connection.closed 先后到达只能广播一次，重复信号不消耗额外恢复额度。
    test(
      "重复死亡信号只广播一次 connected:false",
      async () => {
        const workspace = await makeWorkspace();
        const state = createState(workspace, 5);
        const sent = await startEngine(engine, state);
        const proc = state.process as ChildProcess;

        await killProcess(proc);
        await waitFor(() => state.process === null, "首次失联收口");
        emitLateExit(proc);
        emitLateExit(proc);
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(statusFrames(sent, false)).toHaveLength(1);
      },
      TEST_TIMEOUT_MS,
    );

    // 迟到旧 exit：旧代进程的身份与世代都被 fence 掉，不得清理已就绪的新进程。
    test(
      "迟到旧 exit 不清理新进程",
      async () => {
        const workspace = await makeWorkspace();
        const firstState = createState(workspace, 6);
        await startEngine(engine, firstState);
        const oldProc = firstState.process as ChildProcess;
        await killProcess(oldProc);
        await waitFor(() => firstState.process === null, "旧代失联收口");

        const secondState = createState(workspace, 7);
        await startEngine(engine, secondState);
        const secondProc = secondState.process as ChildProcess;
        emitLateExit(oldProc);
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(secondState.process).toBe(secondProc);
        expect(secondState.sessionState.connection).not.toBeNull();
        expect(secondState.dispatcher).not.toBeNull();

        await killProcess(secondProc);
      },
      TEST_TIMEOUT_MS,
    );
  });
}
