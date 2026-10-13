import type { ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";

/** 退出事实与采用的停止阶段；发送信号本身不是退出确认。 */
export type AgentStopResult = "exited" | "graceful" | "sigterm" | "sigkill";

/** 可注入等待策略，测试无需依赖真实超时。 */
export interface AgentStopOptions {
  drainTimeoutMs?: number;
  termTimeoutMs?: number;
  killTimeoutMs?: number;
  waitForExit?: (child: ChildProcess, timeoutMs: number) => Promise<boolean>;
}

function hasExited(child: ChildProcess): boolean {
  return typeof child.exitCode === "number" || child.signalCode != null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  // Bun 的 ChildProcess 声明缺少 EventEmitter 成员，运行时仍提供标准 Node 事件接口。
  const events = child as unknown as Pick<EventEmitter, "once" | "removeListener">;
  return new Promise((resolve) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      events.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(hasExited(child)), timeoutMs);
    events.once("exit", onExit);
    if (hasExited(child)) finish(true);
  });
}

const pendingStops = new WeakMap<ChildProcess, Promise<AgentStopResult>>();

/**
 * EOF 让 Agent 自行清理独立 session 的 shell；直接杀父进程无法覆盖这些孙进程。
 * 超时才升级信号，最终仍未观察到退出则拒绝，调用方必须保留句柄供重试。
 */
export function stopAgentProcess(child: ChildProcess, options: AgentStopOptions = {}): Promise<AgentStopResult> {
  const pending = pendingStops.get(child);
  if (pending) return pending;
  const operation = stop(child, options).finally(() => pendingStops.delete(child));
  pendingStops.set(child, operation);
  return operation;
}

async function stop(child: ChildProcess, options: AgentStopOptions): Promise<AgentStopResult> {
  if (hasExited(child)) return "exited";
  const wait = options.waitForExit ?? waitForExit;
  const onStdinError = () => console.warn("[agent-stop] stdin 关闭失败，将等待退出或升级信号");
  child.stdin?.on("error", onStdinError);
  try {
    console.info("[agent-stop] 开始 EOF drain");
    try {
      child.stdin?.end();
    } catch {
      onStdinError();
    }
    if (await wait(child, options.drainTimeoutMs ?? 10_000)) return "graceful";
    for (const [signal, timeout, result] of [
      ["SIGTERM", options.termTimeoutMs ?? 2_000, "sigterm"],
      ["SIGKILL", options.killTimeoutMs ?? 2_000, "sigkill"],
    ] as const) {
      console.warn(`[agent-stop] 升级 ${signal}；独立 session 的派生进程可能残留`);
      try {
        child.kill(signal);
      } catch {
        console.warn(`[agent-stop] ${signal} 发送失败，仍需确认退出`);
      }
      if (await wait(child, timeout)) return result;
    }
    throw new Error("Agent process exit could not be confirmed after SIGKILL");
  } finally {
    child.stdin?.removeListener("error", onStdinError);
  }
}
