import type { ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { AcpDispatcher } from "../acp-dispatcher.js";
import { type AcpSessionState, cancelPendingPermissions } from "../acp-session-state.js";

/**
 * ACP 连接在 stdio 关闭/EOF 时落定的最小契约。
 * 适配器可能包装真实连接（如 opencode 的 Proxy），因此只依赖 `closed` 这一事实。
 */
export interface AgentConnectionLifecycle {
  readonly closed?: Promise<unknown>;
}

/** 生命周期收口所需的运行状态字段；结构与 InstanceManager 的 InstanceState 兼容。 */
export interface AgentLifecycleState {
  process: ChildProcess | null;
  connection: AgentConnectionLifecycle | null;
  capabilities: Record<string, unknown> | null;
  sessionState: AcpSessionState;
  dispatcher: AcpDispatcher | null;
  runtimeGeneration: number;
}

export interface AgentProcessLifecycleInput {
  state: AgentLifecycleState;
  process: ChildProcess;
  connection: AgentConnectionLifecycle;
  /** relay 信封已由 InstanceManager 包装，此处只产出 Agent 帧。 */
  send: (message: unknown) => void;
  instanceId: string;
  /** 引擎标识，仅用于诊断日志。 */
  engine: string;
  /** 取消 spawn helper 侧的待决权限与 elicitation（复用 `__cancel_all__` 桥接）。 */
  cancelPendingInteractions?: () => void;
}

export interface AgentProcessLifecycle {
  /** 主动停止：解除监听，计划内退出不得被当作失联广播。 */
  dispose(): void;
}

/**
 * 每个 InstanceState 只保留一份登记：start 成功后才写入，stop 时主动解除。
 * WeakMap 不改变 InstanceManager 的状态结构，也避免实例被回收后残留监听。
 */
const registrations = new WeakMap<object, AgentProcessLifecycle>();

/**
 * 统一收口远端引擎子进程失联：exit、connection.closed、stdout EOF/error 都走同一条幂等路径。
 *
 * 同一代进程只广播一次 `status connected:false`（带 agentPid 与 runtimeGeneration），并清空
 * dispatcher 持有的会话状态——否则后续 `connect` 会把死连接重新宣告为 connected:true。
 * 旧进程迟到的 exit/closed 由进程身份 + runtimeGeneration 双重校验过滤，不会清理新进程。
 */
export function trackAgentProcessLifecycle(input: AgentProcessLifecycleInput): AgentProcessLifecycle {
  const { state, process: proc, connection, send, instanceId, engine } = input;
  const generation = state.runtimeGeneration;
  let announced = false;
  let disposed = false;

  const isCurrent = () => !disposed && state.process === proc && state.runtimeGeneration === generation;

  // Bun 的 ChildProcess 声明缺少 EventEmitter 成员，运行时仍提供标准 Node 事件接口。
  const procEvents = proc as unknown as Pick<EventEmitter, "once" | "removeListener">;

  const removeListeners = () => {
    procEvents.removeListener("exit", onExit);
    procEvents.removeListener("error", onError);
    proc.stdout?.removeListener("end", onStdoutEnd);
    proc.stdout?.removeListener("close", onStdoutEnd);
    proc.stdout?.removeListener("error", onStdoutError);
  };

  const lifecycle: AgentProcessLifecycle = {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      removeListeners();
      if (registrations.get(state) === lifecycle) registrations.delete(state);
    },
  };
  const dispose = () => lifecycle.dispose();
  registrations.set(state, lifecycle);

  const handleLost = (reason: string) => {
    if (!isCurrent()) return;
    const pid = proc.pid;
    // 先清空状态再广播：客户端收到 connected:false 后立刻重连/发 connect 时，
    // dispatcher 必须已经无法把死连接回报为 connected:true。
    state.process = null;
    state.connection = null;
    state.capabilities = null;
    state.dispatcher = null;
    const session = state.sessionState;
    session.connection = null;
    session.sessionId = null;
    session.agentCapabilities = null;
    session.promptCapabilities = null;
    session.modelState = null;
    session.modeState = null;
    cancelPendingPermissions(session);
    try {
      input.cancelPendingInteractions?.();
    } catch (error) {
      console.error(`[${engine}-handler] cancel pending interactions failed: ${instanceId}`, error);
    }
    if (!announced) {
      announced = true;
      console.log(`[${engine}-handler] agent lost: ${instanceId}, pid=${pid}, reason=${reason}`);
      try {
        // 帧形状与本地 startAgent 一致；runtimeGeneration 让主服务按代次 fence 掉迟到事件。
        send({ type: "status", payload: { connected: false, agentPid: pid, runtimeGeneration: generation } });
      } catch (error) {
        console.error(`[${engine}-handler] disconnect status send failed: ${instanceId}`, error);
      }
    }
    dispose();
  };

  const onExit = (code: number | null) => handleLost(`exit:${code ?? "signal"}`);
  const onError = (error: Error) => handleLost(`process-error:${error.message}`);
  const onStdoutEnd = () => handleLost("stdout-eof");
  const onStdoutError = (error: Error) => handleLost(`stdout-error:${error.message}`);

  procEvents.once("exit", onExit);
  procEvents.once("error", onError);
  proc.stdout?.once("end", onStdoutEnd);
  proc.stdout?.once("close", onStdoutEnd);
  proc.stdout?.once("error", onStdoutError);
  // 进程可能在监听器挂载前就已退出（spawn 后立刻崩溃）：事件不会再触发，主动核对一次。
  if (proc.exitCode !== null || proc.signalCode !== null) {
    handleLost("already-exited");
  } else {
    void connection.closed?.then(
      () => handleLost("connection-closed"),
      () => handleLost("connection-closed-error"),
    );
  }

  return lifecycle;
}

/** 主动停止前的解除入口；InstanceManager.stop 调用，避免计划内退出触发失联广播。 */
export function disposeAgentProcessLifecycle(state: object): void {
  const lifecycle = registrations.get(state);
  if (!lifecycle) return;
  lifecycle.dispose();
}
