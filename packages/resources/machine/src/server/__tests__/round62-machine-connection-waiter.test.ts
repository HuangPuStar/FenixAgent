import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MACHINE_CONNECTION_TIMEOUT_MS,
  type MachineSleep,
  waitForMachineConnection,
} from "../services/machine-connection-waiter";

async function withClock<T>(run: (advance: (milliseconds: number) => void) => Promise<T>): Promise<T> {
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;

  try {
    return await run((milliseconds) => {
      now += milliseconds;
    });
  } finally {
    Date.now = originalNow;
  }
}

describe("round62 机器连接等待器真实边界", () => {
  // 默认超时应保持为创建流程约定的三十秒。
  test("导出三十秒默认连接超时", () => {
    expect(DEFAULT_MACHINE_CONNECTION_TIMEOUT_MS).toBe(30_000);
  });

  // 已在线路径必须将请求的机器标识原样交给状态读取器。
  test("首次读取透传机器标识", async () => {
    const ids: string[] = [];

    await waitForMachineConnection("machine/特殊 id", 10_000, async (machineId) => {
      ids.push(machineId);
      return true;
    });

    expect(ids).toEqual(["machine/特殊 id"]);
  });

  // 已在线时不能调用注入的等待器，避免引入额外启动延迟。
  test("首次在线跳过等待器", async () => {
    const wait: MachineSleep = async () => {
      throw new Error("不应等待");
    };

    await expect(waitForMachineConnection("online", 10_000, async () => true, wait)).resolves.toBeUndefined();
  });

  // 离线后在第一次等待完成时上线，应仅进行一次一秒等待。
  test("第一次轮询后上线", async () => {
    let reads = 0;
    const delays: number[] = [];

    await waitForMachineConnection(
      "first-poll",
      10_000,
      async () => ++reads === 2,
      async (delay) => {
        delays.push(delay);
      },
    );

    expect(reads).toBe(2);
    expect(delays).toEqual([1_000]);
  });

  // 连续离线时退避应累加一秒，而不是固定间隔或指数增长。
  test("多次离线使用线性递增退避", async () => {
    let reads = 0;
    const delays: number[] = [];

    await waitForMachineConnection(
      "linear-backoff",
      60_000,
      async () => ++reads === 5,
      async (delay) => {
        delays.push(delay);
      },
    );

    expect(delays).toEqual([1_000, 2_000, 3_000, 4_000]);
  });

  // 每次轮询都必须读取同一机器，不能在重试中丢失或改变标识。
  test("后续轮询保留原机器标识", async () => {
    const ids: string[] = [];

    await waitForMachineConnection(
      "stable-id",
      60_000,
      async (machineId) => {
        ids.push(machineId);
        return ids.length === 4;
      },
      async () => {},
    );

    expect(ids).toEqual(["stable-id", "stable-id", "stable-id", "stable-id"]);
  });

  // 剩余时间不足首个轮询间隔时，等待时间必须被截止时间截断。
  test("首个等待按剩余超时截断", async () => {
    await withClock(async (advance) => {
      const delays: number[] = [];

      await expect(
        waitForMachineConnection(
          "short-deadline",
          250,
          async () => false,
          async (delay) => {
            delays.push(delay);
            advance(delay);
          },
        ),
      ).rejects.toThrow("connection timed out");

      expect(delays).toEqual([250]);
    });
  });

  // 后续退避超过剩余预算时，同样必须只等待剩余时间。
  test("后续等待按剩余超时截断", async () => {
    await withClock(async (advance) => {
      const delays: number[] = [];

      await expect(
        waitForMachineConnection(
          "later-deadline",
          2_500,
          async () => false,
          async (delay) => {
            delays.push(delay);
            advance(delay);
          },
        ),
      ).rejects.toThrow("connection timed out");

      expect(delays).toEqual([1_000, 1_500]);
    });
  });

  // 零超时在首次离线读取后必须立即失败，且绝不能安排等待。
  test("零超时不安排等待", async () => {
    let waits = 0;

    await expect(
      waitForMachineConnection(
        "zero-timeout",
        0,
        async () => false,
        async () => {
          waits += 1;
        },
      ),
    ).rejects.toThrow("machine 'zero-timeout' connection timed out");

    expect(waits).toBe(0);
  });

  // 负超时也属于已过期截止时间，不能进入轮询。
  test("负超时不安排等待", async () => {
    let waits = 0;

    await expect(
      waitForMachineConnection(
        "negative-timeout",
        -1,
        async () => false,
        async () => {
          waits += 1;
        },
      ),
    ).rejects.toThrow("machine 'negative-timeout' connection timed out");

    expect(waits).toBe(0);
  });

  // 初始状态读取的存储故障必须保留原错误，不得转换为连接超时。
  test("传播初始状态读取错误", async () => {
    const failure = new Error("初始读取失败");

    await expect(waitForMachineConnection("reader-failure", 10_000, async () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
  });

  // 重试读取失败时也必须立刻停止，而不是继续下一轮退避。
  test("传播轮询状态读取错误", async () => {
    const failure = new Error("轮询读取失败");
    let reads = 0;
    let waits = 0;

    await expect(
      waitForMachineConnection(
        "later-reader-failure",
        10_000,
        async () => {
          reads += 1;
          if (reads === 2) throw failure;
          return false;
        },
        async () => {
          waits += 1;
        },
      ),
    ).rejects.toBe(failure);

    expect(waits).toBe(1);
  });

  // 等待基础设施故障必须保留原错误，不能误报为机器离线。
  test("传播等待器错误", async () => {
    const failure = new Error("定时器不可用");

    await expect(
      waitForMachineConnection(
        "wait-failure",
        10_000,
        async () => false,
        async () => Promise.reject(failure),
      ),
    ).rejects.toBe(failure);
  });

  // 注入的取消信号以 AbortError 失败时，应终止等待并保留取消原因。
  test("传播等待器取消错误", async () => {
    const cancellation = new DOMException("调用方取消", "AbortError");

    await expect(
      waitForMachineConnection(
        "cancelled",
        10_000,
        async () => false,
        async () => Promise.reject(cancellation),
      ),
    ).rejects.toBe(cancellation);
  });

  // 总截止时间覆盖状态读取；预算耗尽后不得再发起一次可能无限阻塞的查询。
  test("截止时刻不再发起在线读取", async () => {
    await withClock(async (advance) => {
      let reads = 0;

      await expect(
        waitForMachineConnection(
          "online-at-deadline",
          100,
          async () => ++reads === 2,
          async (delay) => {
            advance(delay);
          },
        ),
      ).rejects.toThrow("connection timed out");

      expect(reads).toBe(1);
    });
  });

  // 单次等待完成后离线仍存在时，下一轮应增加退避值再尝试。
  test("离线读取后才增加下一轮退避", async () => {
    const delays: number[] = [];
    let reads = 0;

    await waitForMachineConnection(
      "increment-after-read",
      10_000,
      async () => ++reads === 3,
      async (delay) => {
        delays.push(delay);
      },
    );

    expect(delays).toEqual([1_000, 2_000]);
  });
});
