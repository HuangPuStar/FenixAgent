/**
 * ActiveQueryRegistry（claude-acp-adapter 的 cancel 支撑）测试。
 *
 * cancel 链路断点 2：adapter 的 cancel 原为空实现，且单字段 currentQuery 在
 * 多会话并发下互相覆盖。注册表按 sessionId 精确中断，本文件用 fake Query
 * 直接构造注入（不 mock 模块），覆盖中断、no-op、并发隔离、幂等与标记读取。
 */
import { describe, expect, test } from "bun:test";
import { ActiveQueryRegistry } from "../client/query-registry";

interface FakeQuery {
  interrupt(): Promise<void>;
}

function createFakeQuery(): { query: FakeQuery; interruptCalls(): number } {
  let interruptCalls = 0;
  return {
    query: {
      async interrupt() {
        interruptCalls += 1;
      },
    },
    interruptCalls: () => interruptCalls,
  };
}

describe("ActiveQueryRegistry", () => {
  // cancel 命中目标 session 的活跃 query：interrupt 被调用一次，返回 true
  test("cancel 中断目标 session 的活跃 query", async () => {
    const registry = new ActiveQueryRegistry<FakeQuery>();
    const { query, interruptCalls } = createFakeQuery();
    registry.register("ses-1", query);

    const result = await registry.cancel("ses-1");

    expect(result).toBe(true);
    expect(interruptCalls()).toBe(1);
  });

  // Agent 无会话/无活跃 query 时 cancel 是 no-op：不抛错、返回 false（断点 3 依赖此安全路径）
  test("cancel 无活跃 query 时 no-op 不抛错", async () => {
    const registry = new ActiveQueryRegistry<FakeQuery>();

    await expect(registry.cancel("ses-none")).resolves.toBe(false);
    await expect(registry.cancel(null)).resolves.toBe(false);
  });

  // 多 session 并发：cancel 只中断指定 session，其余 query 不受影响
  test("并发多 session 时 cancel 只中断指定 session", async () => {
    const registry = new ActiveQueryRegistry<FakeQuery>();
    const a = createFakeQuery();
    const b = createFakeQuery();
    registry.register("ses-a", a.query);
    registry.register("ses-b", b.query);

    const result = await registry.cancel("ses-b");

    expect(result).toBe(true);
    expect(a.interruptCalls()).toBe(0);
    expect(b.interruptCalls()).toBe(1);
  });

  // 重复 cancel 幂等：第二次不重复调用 interrupt（聚合层 cancelling 重复取消也跳过）
  test("重复 cancel 幂等：第二个 no-op 不重复调用 interrupt", async () => {
    const registry = new ActiveQueryRegistry<FakeQuery>();
    const { query, interruptCalls } = createFakeQuery();
    registry.register("ses-1", query);

    await registry.cancel("ses-1");
    await registry.cancel("ses-1");

    expect(interruptCalls()).toBe(1);
  });

  // prompt 收尾在 unregister 前读取 cancelRequested 标记，据此返回 stopReason:"cancelled"
  test("peekCancelRequested 在 unregister 前读取标记", async () => {
    const registry = new ActiveQueryRegistry<FakeQuery>();
    const { query } = createFakeQuery();
    registry.register("ses-1", query);

    expect(registry.peekCancelRequested("ses-1")).toBe(false);
    await registry.cancel("ses-1");
    expect(registry.peekCancelRequested("ses-1")).toBe(true);

    registry.unregister("ses-1");
    // 注销后标记清空：未注册的 session 读不到任何状态（默认 false）
    expect(registry.peekCancelRequested("ses-1")).toBe(false);
  });

  // sessionId 为 null（session 尚未建立）时注册的 query 同样可被 cancel 中断（兜底键）
  test("sessionId 为 null 的 query 仍可被取消中断", async () => {
    const registry = new ActiveQueryRegistry<FakeQuery>();
    const { query, interruptCalls } = createFakeQuery();
    registry.register(null, query);

    const result = await registry.cancel(null);

    expect(result).toBe(true);
    expect(interruptCalls()).toBe(1);
  });

  // P1-2：interrupt 抛错（query 已被 SDK 内部清理/transport 抖动）时 cancel 不抛错、
  // 仍返回 true——cancelRequested 标记已置位，prompt 收尾（finally 注销前）仍会读到
  // 标记返回 stopReason:"cancelled"，取消语义不依赖 interrupt 的返回结果
  test("cancel 在 interrupt 抛错时仍返回 true（标记已置位）", async () => {
    const registry = new ActiveQueryRegistry<FakeQuery>();
    const failing: FakeQuery = {
      async interrupt() {
        throw new Error("query already closed");
      },
    };
    registry.register("ses-1", failing);

    await expect(registry.cancel("ses-1")).resolves.toBe(true);
    // 标记仍可被 prompt 收尾读取
    expect(registry.peekCancelRequested("ses-1")).toBe(true);
  });

  // P2-3：同 session 并发二次注册（协议违规）覆盖前调用 reportError 告警而非静默——
  // 便于定位 workflow / 多标签页的异常并发，且旧 query 被覆盖的事实可观测
  test("register 同 session 二次注册时调用 reportError 告警", async () => {
    const warnings: string[] = [];
    const registry = new ActiveQueryRegistry<FakeQuery>({
      reportError: (message) => {
        warnings.push(message);
      },
    });
    registry.register("ses-1", createFakeQuery().query);
    registry.register("ses-1", createFakeQuery().query);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("duplicate register");
    // 新 query 正常可取消（覆盖语义不变，仅增加可观测性）
    await expect(registry.cancel("ses-1")).resolves.toBe(true);
  });

  // P2-3 反向：无 reportError 注入时二次注册不抛错（默认静默，向后兼容）
  test("register 同 session 二次注册无 reportError 时不抛错", async () => {
    const registry = new ActiveQueryRegistry<FakeQuery>();
    registry.register("ses-1", createFakeQuery().query);
    registry.register("ses-1", createFakeQuery().query);

    await expect(registry.cancel("ses-1")).resolves.toBe(true);
  });
});
