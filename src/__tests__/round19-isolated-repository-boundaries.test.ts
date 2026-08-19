import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PgAgentEngineRepo } from "../repositories/agent-engine";
import { PgAgentMachineRepo } from "../repositories/agent-machine";
import { shareLinkRepo } from "../repositories/share-link";
import { taskExecutionLogRepo } from "../repositories/task";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

const engineRepo = new PgAgentEngineRepo();
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

beforeEach(resetAllStubs);
afterEach(resetAllStubs);

describe("round19 隔离仓储边界", () => {
  // 已引用的引擎必须映射为稳定的编排数据。
  test("引擎仓储映射已引用引擎", async () => {
    stubDb({ selectDistinct: () => selected([{ engineType: "opencode" }]) });
    expect(await engineRepo.getEngine("opencode")).toEqual({ id: "opencode", type: "opencode", version: "latest" });
  });

  // 未引用引擎不能被误判为可用。
  test("引擎仓储拒绝不存在引擎", async () => {
    stubDb({ selectDistinct: () => selected([]) });
    expect(await engineRepo.getEngine("unknown")).toBeNull();
  });

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

  // 分享 ID 查询的空结果应为 undefined。
  test("分享链接 ID 空结果", async () => {
    stubDb({ select: () => selected([]) });
    expect(await shareLinkRepo.getById("org", "link")).toBeUndefined();
  });

  // token 查询不得返回任何默认分享链接。
  test("分享链接 token 空结果", async () => {
    stubDb({ select: () => selected([]) });
    expect(await shareLinkRepo.getByToken("unknown")).toBeUndefined();
  });

  // 无快照与空数组快照的协议语义不同。
  test("分享链接无快照返回 null", async () => {
    stubDb({ select: () => selected([]) });
    expect(await shareLinkRepo.getEventSnapshot("link")).toBeNull();
  });

  // 空数组快照必须原样保留。
  test("分享链接保留空数组快照", async () => {
    stubDb({ select: () => selected([{ events: [] }]) });
    expect(await shareLinkRepo.getEventSnapshot("link")).toEqual([]);
  });

  // 事件对象快照不能在仓储层被篡改。
  test("分享链接保留对象快照", async () => {
    const events = { entries: [{ id: "event" }] };
    stubDb({ select: () => selected([{ events }]) });
    expect(await shareLinkRepo.getEventSnapshot("link")).toEqual(events);
  });

  // 删除未命中记录必须明确返回 false。
  test("分享链接删除未命中返回 false", async () => {
    stubDb({ delete: () => ({ where: () => Promise.resolve({ count: 0 }) }) });
    expect(await shareLinkRepo.delete("org", "link")).toBeFalse();
  });

  // 删除命中记录必须明确返回 true。
  test("分享链接删除命中返回 true", async () => {
    stubDb({ delete: () => ({ where: () => Promise.resolve({ count: 1 }) }) });
    expect(await shareLinkRepo.delete("org", "link")).toBeTrue();
  });

  // 快照替换必须先删除旧值，防止历史事件残留。
  test("分享链接快照替换按删除后插入", async () => {
    const steps: string[] = [];
    stubDb({
      delete: () => ({
        where: async () => {
          steps.push("delete");
        },
      }),
      insert: () => ({
        values: async () => {
          steps.push("insert");
        },
      }),
    });
    await shareLinkRepo.saveEventSnapshot("link", []);
    expect(steps).toEqual(["delete", "insert"]);
  });

  // 访问统计的写入必须 await 完成。
  test("分享链接等待访问统计写入", async () => {
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
    await shareLinkRepo.updateAccess("org", "link");
    expect(updated).toBeTrue();
  });

  // 并发分享读取必须互不覆盖结果。
  test("分享链接并发读取隔离", async () => {
    let call = 0;
    stubDb({ select: () => selected([{ id: ++call === 1 ? "a" : "b" }]) });
    const [first, second] = await Promise.all([
      shareLinkRepo.getById("org-a", "a"),
      shareLinkRepo.getById("org-b", "b"),
    ]);
    expect([first?.id, second?.id].sort()).toEqual(["a", "b"]);
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
    stubDb({ select: () => logs([{ id: "latest" }]) });
    expect(await taskExecutionLogRepo.getLatest("task")).toEqual({ id: "latest" });
  });

  // 分享链接按会话列表必须原样返回数据库结果。
  test("分享链接会话列表保留结果", async () => {
    const rows = [{ id: "link-1" }];
    stubDb({ select: () => selected(rows) });
    expect(await shareLinkRepo.listBySession("org", "session")).toEqual(rows);
  });

  // 分享链接按组织列表必须保持组织查询结果。
  test("分享链接组织列表保留结果", async () => {
    const rows = [{ id: "link-2" }];
    stubDb({ select: () => selected(rows) });
    expect(await shareLinkRepo.listByOrganizationId("org")).toEqual(rows);
  });

  // 新建日志应返回数据库记录。
  test("任务日志创建返回记录", async () => {
    stubDb({ insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "new" }]) }) }) });
    expect(await taskExecutionLogRepo.create({ taskId: "task", status: "success" })).toEqual({ id: "new" });
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
    const rows = [{ id: "new" }, { id: "old" }];
    stubDb({ select: () => logs(rows) });
    expect(await taskExecutionLogRepo.listByTask("task")).toEqual(rows);
  });

  // 并发日志查询不得共享可变结果。
  test("任务日志并发读取隔离", async () => {
    let call = 0;
    stubDb({ select: () => logs([{ id: ++call === 1 ? "first" : "second" }]) });
    const [first, second] = await Promise.all([
      taskExecutionLogRepo.getById("first"),
      taskExecutionLogRepo.getById("second"),
    ]);
    expect([first?.id, second?.id].sort()).toEqual(["first", "second"]);
  });
});
