import { describe, expect, test } from "bun:test";
import { INBOUND_MESSAGE_LIMITS, InboundMessageQueue } from "../server/transport/inbound-message-queue";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function queue(owner: string) {
  let overflow = 0;
  const instance = new InboundMessageQueue(
    owner,
    () => {
      overflow++;
    },
    (error) => {
      throw error;
    },
  );
  return { instance, overflow: () => overflow };
}

describe("inbound admission", () => {
  // 握手静默时按条数截断缓存，关闭同时释放所有未执行预算。
  test("bounds pending handshake messages and releases on overflow", () => {
    const q = queue("handshake");
    for (let i = 0; i < INBOUND_MESSAGE_LIMITS.connection.count; i++) expect(q.instance.enqueue("x")).toBe(true);
    expect(q.instance.enqueue("x")).toBe(false);
    expect(q.overflow()).toBe(1);
    expect(q.instance.snapshot()).toEqual({ count: 0, bytes: 0 });
    expect(q.instance.enqueue("x")).toBe(false);
  });

  // 字节预算按UTF-8累计，不能靠少量多字节帧绕过。
  test("counts UTF-8 bytes across maximum legal frames", () => {
    const q = queue("bytes");
    expect(q.instance.enqueue("中".repeat(3 * 1024 * 1024))).toBe(true);
    expect(q.instance.enqueue("中".repeat(3 * 1024 * 1024))).toBe(false);
    expect(q.instance.snapshot().bytes).toBe(0);
  });

  // 慢命令占满普通容量时取消仍可进入受控容量，并且不排在慢命令后。
  test("cancel has reserved capacity and bypasses slow ordinary work", async () => {
    const q = queue("cancel");
    const gate = deferred();
    const seen: string[] = [];
    q.instance.start(async (payload) => {
      seen.push(String(payload));
      if (payload === "slow") await gate.promise;
    });
    q.instance.enqueue("slow");
    for (let i = 1; i < INBOUND_MESSAGE_LIMITS.connection.count; i++) q.instance.enqueue("queued");
    expect(q.instance.enqueue('{"action":"cancel"}')).toBe(true);
    expect(seen).toEqual(["slow", '{"action":"cancel"}']);
    q.instance.close();
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toHaveLength(2);
    expect(q.instance.snapshot()).toEqual({ count: 0, bytes: 0 });
  });

  // 多连接合并按用户计费，不能通过快速重连制造无限的前置缓存。
  test("aggregates admission per user and bounds service memory", () => {
    const queues = Array.from({ length: 5 }, () => queue("same-user"));
    try {
      for (const q of queues.slice(0, 4)) for (let i = 0; i < 64; i++) q.instance.enqueue("x");
      // 用户的两个保留槽只允许控制消息使用。
      expect(queues[4]!.instance.enqueue("ordinary")).toBe(false);
      expect(queues[4]!.overflow()).toBe(1);
    } finally {
      for (const q of queues) q.instance.close();
    }
  });
  // 不同用户的连接共享服务字节预算，租户分散也不能制造无界积压。
  test("bounds aggregate service bytes across different users", () => {
    const queues = Array.from({ length: 9 }, (_, index) => queue(`service-user-${index}`));
    const frame = "x".repeat(8 * 1024 * 1024);
    try {
      for (const q of queues.slice(0, 8)) {
        expect(q.instance.enqueue(frame)).toBe(true);
        expect(q.instance.enqueue(frame)).toBe(true);
      }
      expect(queues[8]!.instance.enqueue(frame)).toBe(false);
      expect(queues[8]!.overflow()).toBe(1);
    } finally {
      for (const q of queues) q.instance.close();
    }
    const recovered = queue("recovered");
    expect(recovered.instance.enqueue(frame)).toBe(true);
    recovered.instance.close();
  });
});
