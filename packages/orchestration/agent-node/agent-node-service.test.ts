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
import { AgentNodeUnavailableError, IllegalStateTransitionError } from "../src/errors";

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

function createNode(socket: AgentNodeSocket, scheduler: MockScheduler, maxRetries = 3): AgentNode {
  return new AgentNode({
    machineId: "m1",
    socket,
    scheduler,
    maxRetries,
    reconnectDelayMs: 10,
    connectTimeoutMs: 100,
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

  test("合法转换：uninitialized → connecting → connected → disconnected → connecting 全链路", () => {
    const fsm = new AgentNodeFsm();
    expect(fsm.transition("connect")).toBe("connecting");
    expect(fsm.transition("open")).toBe("connected");
    expect(fsm.transition("disconnect")).toBe("disconnected");
    expect(fsm.transition("connect")).toBe("connecting");
  });
});

describe("AgentNode", () => {
  test("正常创建：WS 打开后状态为 connected，send 可发送数据", () => {
    const socket = new MockSocket();
    const node = createNode(socket, new MockScheduler());
    node._handleConnected();
    expect(node.status()).toBe("connected");
    node.send({ type: "ping" });
    expect(socket.sent).toEqual([{ type: "ping" }]);
  });

  test("状态转换：意外断连进入 disconnected 并自动重连回到 connected", () => {
    const scheduler = new MockScheduler();
    const socket = new MockSocket();
    const node = createNode(socket, scheduler);
    node._handleConnected();
    expect(node.status()).toBe("connected");

    socket.simulateClose();
    expect(node.status()).toBe("disconnected");
    expect(scheduler.pendingCount()).toBe(1); // 已调度自动重连

    scheduler.fireNext(); // 重连任务触发 → connecting
    expect(node.status()).toBe("connecting");
    socket.simulateOpen(); // 新连接建立 → connected
    expect(node.status()).toBe("connected");
    expect(scheduler.pendingCount()).toBe(0); // 连接超时定时器已清理
  });

  test("主动关闭：connected → close() → closing → closed（等待 WS close 确认）", () => {
    const socket = new DeferredCloseSocket();
    const node = createNode(socket, new MockScheduler());
    node._handleConnected();
    node.close();
    expect(node.status()).toBe("closing");
    expect(socket.closed).toBe(true);

    socket.simulateClose(); // WS 确认关闭
    expect(node.status()).toBe("closed");
  });

  test("重连期间：disconnected 状态下 send() 抛 AgentNodeUnavailableError", () => {
    const socket = new MockSocket();
    const node = createNode(socket, new MockScheduler());
    node._handleConnected();
    socket.simulateClose();
    expect(node.status()).toBe("disconnected");
    expect(() => node.send({ type: "pong" })).toThrow(AgentNodeUnavailableError);
  });

  test("连接失败：connecting 时 error 回退 uninitialized，不再调度重连", () => {
    const scheduler = new MockScheduler();
    const socket = new MockSocket();
    const node = createNode(socket, scheduler);
    node._handleConnected();
    socket.simulateClose(); // → disconnected + 调度重连
    scheduler.fireNext(); // → connecting
    expect(node.status()).toBe("connecting");

    socket.simulateError(); // 重连失败
    expect(node.status()).toBe("uninitialized");
    expect(scheduler.pendingCount()).toBe(0);
  });

  test("连接超时：connecting 超过超时阈值后回退 uninitialized", () => {
    const scheduler = new MockScheduler();
    const socket = new MockSocket();
    const node = createNode(socket, scheduler);
    node._handleConnected();
    socket.simulateClose();
    scheduler.fireNext(); // → connecting，并启动连接超时定时器
    expect(node.status()).toBe("connecting");

    scheduler.fireNext(); // 连接超时任务
    expect(node.status()).toBe("uninitialized");
  });

  test("重试耗尽：maxRetries=0 首次断连即触发 onAutoReconnectStopped，不再调度重连", () => {
    const scheduler = new MockScheduler();
    let stopped = 0;
    const socket = new MockSocket();
    const node = new AgentNode({
      machineId: "m1",
      socket,
      scheduler,
      maxRetries: 0,
      reconnectDelayMs: 10,
      connectTimeoutMs: 100,
      onAutoReconnectStopped: () => {
        stopped += 1;
      },
    });
    node._handleConnected();

    socket.simulateClose(); // 断连：重试额度为 0，立即耗尽
    expect(stopped).toBe(1);
    expect(node.status()).toBe("disconnected");
    expect(scheduler.pendingCount()).toBe(0); // 不再调度重连
  });

  test("重连失败：connecting 失败回退 uninitialized 时触发 onAutoReconnectStopped", () => {
    const scheduler = new MockScheduler();
    let stopped = 0;
    const socket = new MockSocket();
    const node = new AgentNode({
      machineId: "m1",
      socket,
      scheduler,
      maxRetries: 3,
      reconnectDelayMs: 10,
      connectTimeoutMs: 100,
      onAutoReconnectStopped: () => {
        stopped += 1;
      },
    });
    node._handleConnected();

    socket.simulateClose(); // 断连 → 调度重连
    scheduler.fireNext(); // → connecting
    expect(node.status()).toBe("connecting");

    socket.simulateError(); // 重连失败 → uninitialized，自动重连停止
    expect(stopped).toBe(1);
    expect(node.status()).toBe("uninitialized");
    expect(scheduler.pendingCount()).toBe(0);
  });
});

describe("AgentNodeService", () => {
  function createService(scheduler: MockScheduler): AgentNodeService {
    return new AgentNodeService({
      idleTimeoutMs: 100,
      maxRetries: 3,
      reconnectDelayMs: 10,
      connectTimeoutMs: 100,
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

  test("未引用 connected 节点：空闲超时后保留（生命周期跟随 WS），断连耗尽后才回收", () => {
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

    // 机器断连 → 自动重连失败耗尽 → 节点回收（非 connected 节点 close 不触碰 WS）
    socket.simulateClose(); // → disconnected + 调度重连
    scheduler.fireNext(); // 重连任务 → connecting
    socket.simulateError(); // 重连失败 → uninitialized → onAutoReconnectStopped → close
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
  // （A-P1.2 回归点）
  test("ensureNode 拒绝 disconnected 节点并抛 AgentNodeUnavailableError", () => {
    const service = createService(new MockScheduler());
    const socket = new MockSocket();
    const node = service.handleIncomingConnection("m1", socket);
    expect(node.status()).toBe("connected");

    socket.simulateClose(); // 机器断连 → disconnected
    expect(node.status()).toBe("disconnected");
    expect(() => service.ensureNode("m1")).toThrow(AgentNodeUnavailableError);
  });

  // 重连窗口内 connecting 节点同样拒绝：FSM 空转重连期间 WS 未真正可用，放行必然失败。
  // 先 ensureNode 占住引用：否则无引用空闲回收任务先于重连任务触发，会把节点 close
  test("ensureNode 拒绝 connecting 节点", () => {
    const scheduler = new MockScheduler();
    const service = createService(scheduler);
    const socket = new MockSocket();
    const node = service.handleIncomingConnection("m1", socket);
    service.ensureNode("m1"); // 引用 +1，取消未引用空闲定时器
    socket.simulateClose(); // → disconnected + 调度重连
    scheduler.fireNext(); // 重连任务 → connecting
    expect(node.status()).toBe("connecting");
    expect(() => service.ensureNode("m1")).toThrow(AgentNodeUnavailableError);
  });

  // 重连失败回退 uninitialized 的节点同样拒绝（与 disconnected 同语义，覆盖 E-P2.2
  // 的 spawn 放行半：自动重连停止后节点不可承载新实例）
  test("ensureNode 拒绝 uninitialized 节点", () => {
    const scheduler = new MockScheduler();
    const service = createService(scheduler);
    const socket = new MockSocket();
    const node = service.handleIncomingConnection("m1", socket);
    service.ensureNode("m1"); // 引用 +1，取消未引用空闲定时器
    socket.simulateClose(); // → disconnected
    scheduler.fireNext(); // → connecting
    socket.simulateError(); // 重连失败 → uninitialized
    expect(node.status()).toBe("uninitialized");
    expect(() => service.ensureNode("m1")).toThrow(AgentNodeUnavailableError);
  });

  // 错误 message 不得包含 machineId：message 会经 errorPlugin 原样进入响应体，
  // 泄漏 machineId 违反「对外错误不得泄漏敏感信息」约束
  test("ensureNode 错误 message 不含 machineId", () => {
    const service = createService(new MockScheduler());
    const socket = new MockSocket();
    service.handleIncomingConnection("m1", socket);
    socket.simulateClose();
    expect(() => service.ensureNode("m1")).toThrow(expect.not.stringContaining("m1"));
  });

  // 机器重连后恢复放行：断连 → handleIncomingConnection 复用节点 → ensureNode 成功
  // （重连语义不变：节点生命周期跟随机器 WS，重连即恢复）
  test("断连后机器重连（节点复用）ensureNode 恢复放行", () => {
    const service = createService(new MockScheduler());
    const socket1 = new MockSocket();
    const node = service.handleIncomingConnection("m1", socket1);
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
    socket.simulateClose(); // 断连 → 调度重连

    expect(() => service.ensureNode("m1")).toThrow(AgentNodeUnavailableError); // 拒绝路径不得再 +1

    service.releaseNode("m1"); // 归还唯一引用 → 计数归零 → 启动空闲回收
    scheduler.fireNext(); // 重连任务 → connecting
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

  test("自动重连停止：仍有引用时节点保留，引用归零后由空闲回收关闭", () => {
    const scheduler = new MockScheduler();
    const service = createService(scheduler); // maxRetries: 3
    const socket = new MockSocket();
    const node = service.handleIncomingConnection("m1", socket);
    service.ensureNode("m1"); // 引用 +1，取消未引用空闲定时器

    // 断连 → 重连 → 重连失败（connecting error 回退 uninitialized）→ 自动重连停止
    socket.simulateClose();
    scheduler.fireNext(); // 重连任务 → connecting
    socket.simulateError(); // 重连失败
    expect(node.status()).toBe("uninitialized");
    expect(service.activeCount()).toBe(1); // 仍有引用，节点保留

    // 引用归零 → 空闲回收关闭节点并移出管理集合
    service.releaseNode("m1");
    expect(scheduler.pendingCount()).toBe(1);
    scheduler.fireNext();
    expect(node.status()).toBe("closed");
    expect(service.activeCount()).toBe(0);
  });

  test("并发连接：同一 machineId 第二个连接复用已有 AgentNode，旧信道被关闭", () => {
    const service = createService(new MockScheduler());
    const socket1 = new MockSocket();
    const node1 = service.handleIncomingConnection("m1", socket1);
    const socket2 = new MockSocket();
    const node2 = service.handleIncomingConnection("m1", socket2);

    expect(node2).toBe(node1);
    expect(service.activeCount()).toBe(1);
    expect(socket1.closed).toBe(true); // 旧信道被替换关闭
    expect(node2.status()).toBe("connected");
  });

  test("回收后重建：已断连节点经空闲回收移出管理，新连接创建全新节点", () => {
    const scheduler = new MockScheduler();
    const service = createService(scheduler);
    const socket1 = new MockSocket();
    const node1 = service.handleIncomingConnection("m1", socket1);
    service.ensureNode("m1");
    service.releaseNode("m1"); // 引用归零 → 启动空闲回收（任务先于重连任务注册）

    // 机器断连：节点进入 disconnected 并调度自动重连；空闲超时先触发，
    // 节点非 connected → close 直接推进 closed（不触碰 WS 信道）
    socket1.simulateClose();
    scheduler.fireNext(); // 空闲回收 → node1 closed
    expect(node1.status()).toBe("closed");
    expect(service.activeCount()).toBe(0);
    expect(socket1.closed).toBe(false); // 断连态回收不调用 socket.close()

    const socket2 = new MockSocket();
    const node2 = service.handleIncomingConnection("m1", socket2);
    expect(node2).not.toBe(node1);
    expect(node2.status()).toBe("connected");
    expect(service.activeCount()).toBe(1);
  });
});
