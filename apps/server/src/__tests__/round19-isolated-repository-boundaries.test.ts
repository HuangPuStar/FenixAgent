import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { PgAgentMachineRepo } from "@fenix/resource-machine/server";
import { taskExecutionLogRepo } from "@fenix/resource-task/server";

const machineRepo = new PgAgentMachineRepo();

function selected<T>(rows: T[]) {
  const result = Promise.resolve(rows);
  const filtered = Object.assign(result, { limit: () => result, orderBy: () => result });
  return { from: () => ({ where: () => filtered }) };
}

function logs<T>(rows: T[], onOffset?: (value: number) => void) {
  const result = Promise.resolve(rows);
  const ordered = Object.assign(result, {
    limit: () =>
      Object.assign(result, {
        offset: (value: number) => {
          onOffset?.(value);
          return result;
        },
      }),
  });
  const filtered = Object.assign(result, { limit: () => result, orderBy: () => ordered });
  return { from: () => ({ where: () => filtered }) };
}

function taskLog(id: string) {
  return {
    id,
    taskId: "task",
    status: "success",
    error: null,
    duration: null,
    triggeredBy: "manual",
    workspacePath: null,
    workspaceName: null,
    taskSnapshot: null,
    skipReason: null,
    resultSummary: null,
    createdAt: new Date("2026-08-19T00:00:00.000Z"),
  };
}

beforeEach(resetAllStubs);
afterEach(resetAllStubs);

describe("round19 隔离仓储边界", () => {
  // 显式 host 必须优先于 IP。
  test("机器优先显式 host", async () => {
    stubDb({ select: () => selected([{ machineInfo: { host: "relay", ip: "10.0.0.1", port: 8443 } }]) });
    expect(await machineRepo.getMachine("m")).toEqual({ id: "m", host: "relay", port: 8443 });
  });

  // 注册上报 IP 是 host 的安全回退。
  test("机器使用 IP 回退", async () => {
    stubDb({ select: () => selected([{ machineInfo: { ip: "10.0.0.1" } }]) });
    expect((await machineRepo.getMachine("m"))?.host).toBe("10.0.0.1");
  });

  // 空 host 不得掩盖可用 IP。
  test("机器忽略空 host", async () => {
    stubDb({ select: () => selected([{ machineInfo: { host: "", ip: "10.0.0.1" } }]) });
    expect((await machineRepo.getMachine("m"))?.host).toBe("10.0.0.1");
  });

  // 缺失地址使用安全回环兜底。
  test("机器缺失地址使用回环兜底", async () => {
    stubDb({ select: () => selected([{ machineInfo: {} }]) });
    expect((await machineRepo.getMachine("m"))?.host).toBe("127.0.0.1");
  });

  // null 元数据不可被解构为连接配置。
  test("机器拒绝 null 元数据", async () => {
    stubDb({ select: () => selected([{ machineInfo: null }]) });
    expect(await machineRepo.getMachine("m")).toEqual({ id: "m", host: "127.0.0.1", port: 0 });
  });

  // 数组不是合法的 JSON 对象元数据。
  test("机器拒绝数组元数据", async () => {
    stubDb({ select: () => selected([{ machineInfo: ["bad"] }]) });
    expect((await machineRepo.getMachine("m"))?.port).toBe(0);
  });

  // 标量元数据必须安全降级。
  test("机器拒绝标量元数据", async () => {
    stubDb({ select: () => selected([{ machineInfo: "bad" }]) });
    expect((await machineRepo.getMachine("m"))?.host).toBe("127.0.0.1");
  });

  // 合法数值端口应透传。
  test("机器接受数值端口", async () => {
    stubDb({ select: () => selected([{ machineInfo: { port: 65535 } }]) });
    expect((await machineRepo.getMachine("m"))?.port).toBe(65535);
  });

  // 浮点端口必须收窄为 TCP 整数端口。
  test("机器截断浮点端口", async () => {
    stubDb({ select: () => selected([{ machineInfo: { port: 3000.9 } }]) });
    expect((await machineRepo.getMachine("m"))?.port).toBe(3000);
  });

  // 字符串端口允许带空白的配置输入。
  test("机器解析字符串端口", async () => {
    stubDb({ select: () => selected([{ machineInfo: { port: " 3000 " } }]) });
    expect((await machineRepo.getMachine("m"))?.port).toBe(3000);
  });

  // 零端口不应成为远端实际端口。
  test("机器拒绝零端口", async () => {
    stubDb({ select: () => selected([{ machineInfo: { port: 0 } }]) });
    expect((await machineRepo.getMachine("m"))?.port).toBe(0);
  });

  // 超范围端口不能传入连接层。
  test("机器拒绝超范围端口", async () => {
    stubDb({ select: () => selected([{ machineInfo: { port: 65536 } }]) });
    expect((await machineRepo.getMachine("m"))?.port).toBe(0);
  });

  // 非数字端口字符串必须被拒绝。
  test("机器拒绝非数字端口", async () => {
    stubDb({ select: () => selected([{ machineInfo: { port: "http" } }]) });
    expect((await machineRepo.getMachine("m"))?.port).toBe(0);
  });

  // 负端口不是合法 TCP 端口。
  test("机器拒绝负端口", async () => {
    stubDb({ select: () => selected([{ machineInfo: { port: -1 } }]) });
    expect((await machineRepo.getMachine("m"))?.port).toBe(0);
  });

  // Infinity 不能作为网络端口进入连接层。
  test("机器拒绝无限端口", async () => {
    stubDb({ select: () => selected([{ machineInfo: { port: Number.POSITIVE_INFINITY } }]) });
    expect((await machineRepo.getMachine("m"))?.port).toBe(0);
  });

  // 空白端口字符串不能绕过端口校验。
  test("机器拒绝空白端口", async () => {
    stubDb({ select: () => selected([{ machineInfo: { port: "   " } }]) });
    expect((await machineRepo.getMachine("m"))?.port).toBe(0);
  });

  // 字符串浮点端口与数值浮点端口使用一致的截断语义。
  test("机器截断字符串浮点端口", async () => {
    stubDb({ select: () => selected([{ machineInfo: { port: "8080.9" } }]) });
    expect((await machineRepo.getMachine("m"))?.port).toBe(8080);
  });

  // 不存在机器不得伪造本地机器。
  test("机器不存在返回空", async () => {
    stubDb({ select: () => selected([]) });
    expect(await machineRepo.getMachine("missing")).toBeNull();
  });

  // 最新日志为空时应使用 null 协议值。
  test("任务日志最新空结果", async () => {
    stubDb({ select: () => logs([]) });
    expect(await taskExecutionLogRepo.getLatest("task")).toBeNull();
  });

  // 按 ID 查询空结果应使用 null 协议值。
  test("任务日志 ID 空结果", async () => {
    stubDb({ select: () => logs([]) });
    expect(await taskExecutionLogRepo.getById("log")).toBeNull();
  });

  // 最新日志返回数据库排序后的第一项。
  test("任务日志最新返回第一项", async () => {
    stubDb({ select: () => logs([taskLog("latest")]) });
    expect(await taskExecutionLogRepo.getLatest("task")).toMatchObject({ id: "latest" });
  });

  // 新建日志应返回数据库记录。
  test("任务日志创建返回记录", async () => {
    stubDb({ insert: () => ({ values: () => ({ returning: () => Promise.resolve([taskLog("new")]) }) }) });
    expect(await taskExecutionLogRepo.create({ taskId: "task", status: "success" })).toMatchObject({ id: "new" });
  });

  // 更新日志必须在写入结束后 resolve。
  test("任务日志等待更新完成", async () => {
    let updated = false;
    stubDb({
      update: () => ({
        set: () => ({
          where: async () => {
            updated = true;
          },
        }),
      }),
    });
    await taskExecutionLogRepo.update("log", { status: "failed" });
    expect(updated).toBeTrue();
  });

  // 删除日志必须在资源清理后 resolve。
  test("任务日志等待删除完成", async () => {
    let deleted = false;
    stubDb({
      delete: () => ({
        where: async () => {
          deleted = true;
        },
      }),
    });
    await taskExecutionLogRepo.deleteByTask("task");
    expect(deleted).toBeTrue();
  });

  // 列表应保持数据库提供的时间排序。
  test("任务日志保留列表顺序", async () => {
    const rows = [taskLog("new"), taskLog("old")];
    stubDb({ select: () => logs(rows) });
    expect(await taskExecutionLogRepo.listByTask("task")).toEqual(rows);
  });

  // 并发日志查询不得共享可变结果。
  test("任务日志并发读取隔离", async () => {
    let call = 0;
    stubDb({ select: () => logs([taskLog(++call === 1 ? "first" : "second")]) });
    const [first, second] = await Promise.all([
      taskExecutionLogRepo.getById("first"),
      taskExecutionLogRepo.getById("second"),
    ]);
    expect([first?.id, second?.id].sort()).toEqual(["first", "second"]);
  });
});
