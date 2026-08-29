import { describe, expect, test } from "bun:test";
import { ModelGatewayError } from "@fenix/model-gateway-sdk";
import {
  createModelGatewayReconcileJob,
  type ModelGatewayReconcileJobDeps,
} from "../services/model-gateway/reconcile-job";

function mapping(id: string, valid: boolean) {
  return { id, externalCredentialId: `key-${id}`, valid };
}
type FakeMapping = ReturnType<typeof mapping>;

describe("model gateway reconcile job", () => {
  // 验证对账任务必须显式声明调度规则和时区，避免部署环境静默采用错误的默认时区。
  test("requires an explicit schedule configuration", () => {
    expect(() => createModelGatewayReconcileJob({} as ModelGatewayReconcileJobDeps, undefined as never)).toThrow(
      "model gateway reconcile schedule options are required",
    );
    expect(() =>
      createModelGatewayReconcileJob({} as ModelGatewayReconcileJobDeps, { cron: "", timezone: "Asia/Shanghai" }),
    ).toThrow("model gateway reconcile cron is required");
    expect(() =>
      createModelGatewayReconcileJob({} as ModelGatewayReconcileJobDeps, { cron: "0 3 * * *", timezone: "" }),
    ).toThrow("model gateway reconcile timezone is required");
  });

  // 验证夜间任务扫描失效主体、禁用远端 Key，并把 404 视为已完成。
  test("扫描 active/error，批量并发禁用失效映射，404 视为成功", async () => {
    const blocked: string[] = [];
    const statuses: string[] = [];
    const cleared: string[] = [];
    const rows = [mapping("1", false), mapping("2", true), mapping("3", false)];
    let returned = false;
    const job = createModelGatewayReconcileJob(
      {
        listMappings: async () => {
          if (returned) return [];
          returned = true;
          return rows;
        },
        isSubjectValid: async (row: FakeMapping) => row.valid,
        blockCredential: async (key: string) => {
          blocked.push(key);
          if (key === "key-1") throw new ModelGatewayError("NOT_FOUND", "not found");
        },
        updateStatus: async (id: string) => {
          statuses.push(id);
        },
        clearCredential: async (id: string) => {
          cleared.push(id);
        },
        withLock: async <T>(fn: () => Promise<T>) => fn(),
      } as unknown as ModelGatewayReconcileJobDeps,
      { cron: "0 3 * * *", timezone: "Asia/Shanghai" },
    );

    const result = await job.run();

    expect(result).toMatchObject({ scanned: 3, invalid: 2, blocked: 2, failed: 0, skipped: false });
    expect(blocked.sort()).toEqual(["key-1", "key-3"]);
    expect(statuses.sort()).toEqual(["1", "3"]);
    expect(cleared.sort()).toEqual(["1", "3"]);
  });

  // 验证分布式锁未取得时本轮直接跳过，避免重复执行撤销操作。
  test("未取得 advisory lock 时跳过本轮，不补跑", async () => {
    let listed = false;
    const job = createModelGatewayReconcileJob(
      {
        listMappings: async () => {
          listed = true;
          return [];
        },
        isSubjectValid: async (_row: FakeMapping) => true,
        blockCredential: async (_key: string) => {},
        updateStatus: async (_id: string) => {},
        clearCredential: async (_id: string) => {},
        withLock: async () => null,
      } as unknown as ModelGatewayReconcileJobDeps,
      { cron: "0 3 * * *", timezone: "Asia/Shanghai" },
    );

    const result = await job.run();

    expect(result.skipped).toBe(true);
    expect(listed).toBe(false);
  });
});
