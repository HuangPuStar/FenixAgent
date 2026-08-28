/**
 * AgentNode 子域测试：状态机、AgentNode 生命周期与 AgentNodeService 引用计数/回收。
 *
 * 全部通过 mock 注入（MockSocket / MockScheduler），不依赖真实 WS、时钟或数据库；
 * 直接构造注入，禁止 mock.module()。
 */

import { describe, expect, test } from "bun:test";
import { AgentNode } from "../src/agent-node/agent-node";
import { AgentNodeFsm } from "../src/agent-node/agent-node-fsm";
import { AgentNodeService } from "../src/agent-node/agent-node-service";
import type { AgentNodeSocket, TimerScheduler } from "../src/agent-node/types";
import {
  AgentNodeConnectionConflictError,
  AgentNodeUnavailableError,
  IllegalStateTransitionError,
} from "../src/errors";

/** Mock WS 信道：记录发送数据，可手动触发 open/close/error 事件。 */
class MockSocket implements AgentNodeSocket {
  sent: unknown[] = [];
  closed = false;
  #openHandler: (() => void) | null = null;
  #closeHandler: (() => void) | null = null;
  #errorHandler: (() => void) | null = null;

  onOpen(handler: () => void): void {
    this.#openHandler = handler;
  }

  onClose(handler: () => void): void {
    this.#closeHandler = handler;
  }

  onError(handler: () => void): void {
    this.#errorHandler = handler;
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.#closeHandler?.();
  }

  simulateOpen(): void {
    this.#openHandler?.();
  }

  simulateClose(): void {
    this.#closeHandler?.();
  }

  simulateError(): void {
    this.#errorHandler?.();
  }
}

/** close() 不立即触发 onClose 的 Mock 信道：用于观察 closing 中间态。 */
class DeferredCloseSocket extends MockSocket {
  override close(): void {
    this.closed = true;
    // 不触发 onClose，由测试手动 simulateClose() 完成确认
  }
}

/** Mock 定时器：任务手动触发，支持取消标记。 */
class MockScheduler implements TimerScheduler {
  #tasks: { handler: () => void; cancelled: boolean }[] = [];

  setTimeout(handler: () => void): unknown {
    const task = { handler, cancelled: false };
    this.#tasks.push(task);
    return task;
  }

  clearTimeout(handle: unknown): void {
    (handle as { cancelled: boolean }).cancelled = true;
  }

  /** 触发下一个未取消的任务，返回是否真的有任务被执行。 */
  fireNext(): boolean {
    const task = this.#tasks.find((t) => !t.cancelled);
    if (task === undefined) {
      return false;
    }
    task.cancelled = true;
    task.handler();
    return true;
  }

  /** 当前尚未执行（未取消）的任务数。 */
  pendingCount(): number {
    return this.#tasks.filter((t) => !t.cancelled).length;
  }
}

function createNode(socket: AgentNodeSocket, options?: { onAutoReconnectStopped?: () => void }): AgentNode {
  return new AgentNode({
    machineId: "m1",
    socket,
    ...options,
  });
}

describe("AgentNodeFsm", () => {
  test("非法转换：connected 状态调用 connect() 抛 IllegalStateTransitionError", () => {
    const fsm = new AgentNodeFsm("connected");
    expect(() => fsm.transition("connect")).toThrow(IllegalStateTransitionError);
  });

  test("非法转换：终态 closed 不再接受任何事件", () => {
    const fsm = new AgentNodeFsm("closed");
    expect(() => fsm.transition("closeRequested")).toThrow(IllegalStateTransitionError);
  });

  test("非法转换：uninitialized 状态直接 open 抛错", () => {
    const fsm = new AgentNodeFsm("uninitialized");
    expect(() => fsm.transition("open")).toThrow(IllegalStateTransitionError);
  });

  // E-P2.2 方案 A：disconnected 不接受 connect（server 不自动重连），
  // 仅接受机器新连接到达时的 open 被动恢复
  test("合法转换：uninitialized → connecting → connected → disconnected → open 恢复全链路", () => {
    const fsm = new AgentNodeFsm();
    expect(fsm.transition("connect")).toBe("connecting");
    expect(fsm.transition("open")).toBe("connected");
    expect(fsm.transition("disconnect")).toBe("disconnected");
    expect(fsm.transition("open")).toBe("connected");
  });

  test("非法转换：disconnected 状态调用 connect() 抛 IllegalStateTransitionError（方案 A 无自动重连）", () => {
    const fsm = new AgentNodeFsm("disconnected");
    expect(() => fsm.transition("connect")).toThrow(IllegalStateTransitionError);
  });
});

describe("AgentNode", () => {
  test("正常创建：WS 打开后状态为 connected，send 可发送数据", () => {
    const socket = new MockSocket();
    const node = createNode(socket);
    node._handleConnected();
    expect(node.status()).toBe("connected");
    node.send({ type: "ping" });
    expect(socket.sent).toEqual([{ type: "ping" }]);
  });

  // E-P2.2 方案 A：server 端不做自动重连，断连即停留在 disconnected 并通知宿主；
  // 恢复完全由远端 Machine 驱动（_attachSocket 新信道 + open）
  test("断连后不自动重连：保持 disconnected，机器新连接（attach + open）恢复 connected", () => {
    let stopped = 0;
    const socket = new MockSocket();
    const node = createNode(socket, { onAutoReconnectStopped: () => (stopped += 1) });
    node._handleConnected();
    expect(node.status()).toBe("connected");

    socket.simulateClose();
    expect(node.status()).toBe("disconnected");
    expect(stopped).toBe(1); // 断连立即触发自动重连停止信号
    expect(node.status()).toBe("disconnected"); // 不再有任何定时器驱动状态

    const socket2 = new MockSocket();
    node._attachSocket(socket2); // 机器新连接到达（handleIncomingConnection 复用分支）
    node._handleConnected();
    expect(node.status()).toBe("connected");
    expect(socket.closed).toBe(true); // 旧信道被关闭
  });

  test("主动关闭：connected → close() → closing → closed（等待 WS close 确认）", () => {
    const socket = new DeferredCloseSocket();
    const node = createNode(socket);
    node._handleConnected();
    node.close();
    expect(node.status()).toBe("closing");
    expect(socket.closed).toBe(true);

    socket.simulateClose(); // WS 确认关闭
    expect(node.status()).toBe("closed");
  });

  test("断连期间：disconnected 状态下 send() 抛 AgentNodeUnavailableError", () => {
    const socket = new MockSocket();
    const node = createNode(socket);
    node._handleConnected();
    socket.simulateClose();
    expect(node.status()).toBe("disconnected");
    expect(() => node.send({ type: "pong" })).toThrow(AgentNodeUnavailableError);
  });

  // E-P2.2 方案 A：断连即触发 onAutoReconnectStopped，不再有重试额度 / 定时器
  test("断连立即触发 onAutoReconnectStopped（无重试配置）", () => {
    let stopped = 0;
    const socket = new MockSocket();
    const node = createNode(socket, {
      onAutoReconnectStopped: () => {
        stopped += 1;
      },
    });
    node._handleConnected();

    socket.simulateClose(); // 断连：无重试，立即停止
    expect(stopped).toBe(1);
    expect(node.status()).toBe("disconnected");
  });
});

describe("AgentNodeService", () => {
  function createService(scheduler: MockScheduler): AgentNodeService {
    return new AgentNodeService({
      idleTimeoutMs: 100,
      scheduler,
    });
  }

  test("正常创建：被动连接生成 connected 的 AgentNode 并纳入管理", () => {
    const service = createService(new MockScheduler());
    const socket = new MockSocket();
    const node = service.handleIncomingConnection("m1", socket);
    expect(node.machineId).toBe("m1");
    expect(node.status()).toBe("connected");
    expect(service.activeCount()).toBe(1);
  });

  // E-P2.2 方案 A：机器断连（无引用）→ onAutoReconnectStopped 立即回收，不再
  // 等待空转定时器；connected 节点仍由空闲回收保留（E-P1.1 回归）
  test("未引用 connected 节点：空闲超时后保留（生命周期跟随 WS），断连立即回收", () => {
    const scheduler = new MockScheduler();
    const service = createService(scheduler);
    const socket = new MockSocket();
    const node = service.handleIncomingConnection("m1", socket);

    // 无引用计数时立即启动空闲回收，但机器在线（connected）节点只保留不关闭：
    // 关闭会切断机器真实 WS，造成每 idleTimeoutMs 一次的断连-重连风暴（E-P1.1）
    expect(scheduler.pendingCount()).toBe(1);
    scheduler.fireNext(); // 空闲超时 → connected 节点保留
    expect(node.status()).toBe("connected");
    expect(service.activeCount()).toBe(1);
    expect(socket.closed).toBe(false);

    // 机器断连 → 无引用 → 立即关闭并移出（断连态 close 不触碰 WS）
    socket.simulateClose();
    expect(node.status()).toBe("closed");
    expect(service.activeCount()).toBe(0);
    expect(socket.closed).toBe(false); // 断连态回收只推进 FSM，不调用 socket.close()
  });

  test("ensureNode：节点不存在时抛 AgentNodeUnavailableError", () => {
    const service = createService(new MockScheduler());
    expect(() => service.ensureNode("ghost")).toThrow(AgentNodeUnavailableError);
  });

  // 断连节点不得放行：机器断连（disconnected）后 ensureNode 必须抛
  // AgentNodeUnavailableError，否则 spawn 会走死信道在 core 侧落成 NODE_OFFLINE(500)
  // （A-P1.2 回归点）；先占住引用以观察 disconnected 保留态（无引用时断连即回收）
  test("ensureNode 拒绝 disconnected 节点并抛 AgentNodeUnavailableError", () => {
    const service = createService(new MockScheduler());
    const socket = new MockSocket();
    const node = service.handleIncomingConnection("m1", socket);
    service.ensureNode("m1"); // 引用 +1：断连后节点保留
    expect(node.status()).toBe("connected");

    socket.simulateClose(); // 机器断连 → disconnected
    expect(node.status()).toBe("disconnected");
    expect(() => service.ensureNode("m1")).toThrow(AgentNodeUnavailableError);
  });

  // E-P2.2 方案 A：连接建立后节点只可能处于 connected / disconnected（connecting 为
  // 瞬态、uninitialized 仅存在于构造时），disconnected 拒绝测试已覆盖非 connected
  // 放行拒绝语义；connecting/uninitialized 的 FSM 转换仍由 AgentNodeFsm 单测覆盖。

  // 错误 message 不得包含 machineId：message 会经 errorPlugin 原样进入响应体，
  // 泄漏 machineId 违反「对外错误不得泄漏敏感信息」约束
  test("ensureNode 错误 message 不含 machineId", () => {
    const service = createService(new MockScheduler());
    const socket = new MockSocket();
    service.handleIncomingConnection("m1", socket);
    socket.simulateClose();
    expect(() => service.ensureNode("m1")).toThrow(expect.not.stringContaining("m1"));
  });

  // 机器重连后恢复放行：断连（有引用保留）→ handleIncomingConnection 复用节点 → ensureNode 成功
  // （重连语义不变：节点生命周期跟随机器 WS，重连即恢复）
  test("断连后机器重连（节点复用）ensureNode 恢复放行", () => {
    const service = createService(new MockScheduler());
    const socket1 = new MockSocket();
    const node = service.handleIncomingConnection("m1", socket1);
    service.ensureNode("m1"); // 引用 +1：断连后节点保留等待重连
    socket1.simulateClose(); // 断连
    expect(() => service.ensureNode("m1")).toThrow(AgentNodeUnavailableError);

    const socket2 = new MockSocket();
    service.handleIncomingConnection("m1", socket2); // 机器重连 → 复用节点恢复 connected
    expect(node.status()).toBe("connected");
    expect(service.ensureNode("m1")).toBe(node);
  });

  // 引用计数不泄漏：拒绝路径不得 +1（ensureNode 先检查后递增），否则 releaseNode
  // 归零回收逻辑会被跳过，节点永久滞留管理集合。通过「拒绝后归还唯一引用 →
  // 空闲回收触发并关闭节点」的行为链验证
  test("ensureNode 拒绝时引用计数不变", () => {
    const scheduler = new MockScheduler();
    const service = createService(scheduler);
    const socket = new MockSocket();
    service.handleIncomingConnection("m1", socket);
    service.ensureNode("m1"); // 引用 +1，取消未引用空闲定时器
    socket.simulateClose(); // 断连（有引用 → 节点保留，onAutoReconnectStopped 不关闭）

    expect(() => service.ensureNode("m1")).toThrow(AgentNodeUnavailableError); // 拒绝路径不得再 +1

    service.releaseNode("m1"); // 归还唯一引用 → 计数归零 → 启动空闲回收
    scheduler.fireNext(); // 空闲回收 → 非 connected 节点关闭并移出管理集合
    expect(service.activeCount()).toBe(0);
    expect(socket.closed).toBe(false); // 断连态回收只推进 FSM，不调用 socket.close()
  });

  test("引用归零后空闲超时：connected 节点保留且不关闭 WS 信道，新 ensureNode 直接复用同一节点", () => {
    const scheduler = new MockScheduler();
    const service = createService(scheduler);
    const socket = new MockSocket();
    const node = service.handleIncomingConnection("m1", socket);

    const a = service.ensureNode("m1");
    const b = service.ensureNode("m1");
    const c = service.ensureNode("m1");
    expect(a).toBe(node);
    expect(b).toBe(node);
    expect(c).toBe(node);

    service.releaseNode("m1");
    service.releaseNode("m1");
    expect(scheduler.pendingCount()).toBe(0); // 计数未归零，不启动回收
    service.releaseNode("m1");
    expect(scheduler.pendingCount()).toBe(1); // 归零后启动空闲回收

    // 机器在线（connected）节点不被空闲回收关闭，WS 信道保持（E-P1.1 回归）
    scheduler.fireNext();
    expect(node.status()).toBe("connected");
    expect(socket.closed).toBe(false);
    expect(service.activeCount()).toBe(1);

    // 新引用直接复用同一节点，不抛 AgentNodeUnavailableError
    expect(service.ensureNode("m1")).toBe(node);
  });

  test("空闲回收取消：归零后新 ensureNode 到达取消定时器，节点保持可用", () => {
    const scheduler = new MockScheduler();
    const service = createService(scheduler);
    const socket = new MockSocket();
    const node = service.handleIncomingConnection("m1", socket);

    service.ensureNode("m1");
    service.releaseNode("m1");
    expect(scheduler.pendingCount()).toBe(1);

    service.ensureNode("m1"); // 新引用到达 → 取消回收
    expect(scheduler.pendingCount()).toBe(0);
    expect(scheduler.fireNext()).toBe(false);
    expect(node.status()).toBe("connected");
    expect(service.activeCount()).toBe(1);
  });

  // E-P2.2 方案 A：断连（有引用）即停止重连并保留节点，引用归零后由空闲回收关闭
  test("断连停止重连：仍有引用时节点保留，引用归零后由空闲回收关闭", () => {
    const scheduler = new MockScheduler();
    const service = createService(scheduler);
    const socket = new MockSocket();
    const node = service.handleIncomingConnection("m1", socket);
    service.ensureNode("m1"); // 引用 +1，取消未引用空闲定时器

    socket.simulateClose(); // 断连 → onAutoReconnectStopped（有引用 → 节点保留）
    expect(node.status()).toBe("disconnected");
    expect(service.activeCount()).toBe(1); // 仍有引用，节点保留

    // 引用归零 → 空闲回收关闭节点并移出管理集合
    service.releaseNode("m1");
    expect(scheduler.pendingCount()).toBe(1);
    scheduler.fireNext();
    expect(node.status()).toBe("closed");
    expect(service.activeCount()).toBe(0);
  });

  // 同一 machine 的在线连接是唯一真实控制信道，第二个连接必须被拒绝，不能替换第一个。
  test("并发连接：同一 machineId 第二个连接抛冲突错误并保留旧信道", () => {
    const service = createService(new MockScheduler());
    const socket1 = new MockSocket();
    const node1 = service.handleIncomingConnection("m1", socket1);
    const socket2 = new MockSocket();

    expect(() => service.handleIncomingConnection("m1", socket2)).toThrow(AgentNodeConnectionConflictError);
    expect(service.activeCount()).toBe(1);
    expect(socket1.closed).toBe(false);
    expect(node1.status()).toBe("connected");
    expect(socket2.closed).toBe(false);
  });

  test("回收后重建：断连（无引用）即回收移出管理，新连接创建全新节点", () => {
    const scheduler = new MockScheduler();
    const service = createService(scheduler);
    const socket1 = new MockSocket();
    const node1 = service.handleIncomingConnection("m1", socket1);
    service.ensureNode("m1");
    service.releaseNode("m1"); // 引用归零 → 启动空闲回收

    // 机器断连且无引用：onAutoReconnectStopped 立即关闭节点（不触碰 WS 信道），
    // 无需等待空闲超时；closed 后移出管理集合并取消空闲定时器
    socket1.simulateClose();
    expect(node1.status()).toBe("closed");
    expect(service.activeCount()).toBe(0);
    expect(socket1.closed).toBe(false); // 断连态回收不调用 socket.close()
    expect(scheduler.pendingCount()).toBe(0); // 节点移除后空闲定时器已取消

    const socket2 = new MockSocket();
    const node2 = service.handleIncomingConnection("m1", socket2);
    expect(node2).not.toBe(node1);
    expect(node2.status()).toBe("connected");
    expect(service.activeCount()).toBe(1);
  });
});

describe("AgentNodeService.notifyNodeDisconnected", () => {
  function createService(scheduler: MockScheduler): AgentNodeService {
    return new AgentNodeService({
      idleTimeoutMs: 100,
      scheduler,
    });
  }

  // 宿主 sweep 清理路径无 entry.ws 可引用，只能按 machineId 通知断连：
  // connected 节点必须进入 disconnected 且不再调度任何定时器（E-P2.2 方案 A，
  // 与 WS close 事件同语义）；先占住引用以观察 disconnected 保留态（无引用时
  // 断连会立即回收）
  test("notifyNodeDisconnected：connected 节点进入 disconnected 且不调度定时器", () => {
    const scheduler = new MockScheduler();
    const service = createService(scheduler);
    const socket = new MockSocket();
    const node = service.handleIncomingConnection("m1", socket);
    service.ensureNode("m1"); // 引用 +1：断连后节点保留（等待引用归零回收）
    expect(node.status()).toBe("connected");

    service.notifyNodeDisconnected("m1");
    expect(node.status()).toBe("disconnected");
    expect(scheduler.pendingCount()).toBe(0); // 无自动重连定时器（方案 A）
  });

  // sweep 每 60s 巡检，服务重启后 DB 残留 online 的 machine 未必有节点：
  // 未管理 machineId 必须幂等忽略，不得抛错
  test("notifyNodeDisconnected：未管理的 machineId 不抛错", () => {
    const service = createService(new MockScheduler());
    expect(() => service.notifyNodeDisconnected("m-unknown")).not.toThrow();
    expect(service.activeCount()).toBe(0);
  });

  // sweep 与 WS close 事件可能并发触发通知：已断连节点重复通知必须幂等，
  // 不得抛 IllegalStateTransitionError（先占住引用使断连后节点保留）
  test("notifyNodeDisconnected：已断连节点重复通知幂等", () => {
    const scheduler = new MockScheduler();
    const service = createService(scheduler);
    const socket = new MockSocket();
    const node = service.handleIncomingConnection("m1", socket);
    service.ensureNode("m1"); // 引用 +1：断连后节点保留
    socket.simulateClose(); // WS close 先到达 → disconnected
    expect(node.status()).toBe("disconnected");

    expect(() => service.notifyNodeDisconnected("m1")).not.toThrow();
    expect(node.status()).toBe("disconnected");
  });

  // 主动关闭中间态（closing）的通知与 WS close 确认同语义：推进 closed，
  // 节点随后移出管理集合
  test("notifyNodeDisconnected：closing 节点推进 closed", () => {
    const service = createService(new MockScheduler());
    const socket = new DeferredCloseSocket();
    const node = service.handleIncomingConnection("m1", socket);
    node.close(); // → closing（DeferredCloseSocket 不立即确认）
    expect(node.status()).toBe("closing");

    service.notifyNodeDisconnected("m1"); // 等价于 WS close 确认
    expect(node.status()).toBe("closed");
    expect(service.activeCount()).toBe(0);
  });

  // 通知后 ensureNode 必须拒绝：sweep 已判定机器断连，节点 stale connected 时
  // 放行 spawn 会走死信道（E-P2.1 主验收点）；message 不得含 machineId（脱敏约束）
  test("notifyNodeDisconnected 后 ensureNode 拒绝", () => {
    const service = createService(new MockScheduler());
    const socket = new MockSocket();
    const node = service.handleIncomingConnection("m1", socket);
    service.ensureNode("m1"); // 引用 +1：sweep 通知后节点保留但不得放行

    service.notifyNodeDisconnected("m1");
    expect(node.status()).toBe("disconnected");
    expect(() => service.ensureNode("m1")).toThrow(AgentNodeUnavailableError);
    expect(() => service.ensureNode("m1")).toThrow(expect.not.stringContaining("m1"));
  });
});
