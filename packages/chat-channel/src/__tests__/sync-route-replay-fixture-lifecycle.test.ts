import { expect, test } from "bun:test";
import { AdmissionController, type ServerPoolName } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { routeReplayFixture, usage } from "./sync-route-replay-fixture";

/** 首次 scope 计费成功后拒绝下一次预留，保留真实预算的释放行为。 */
class SetupFailureAdmission extends AdmissionController {
  readonly setupError = new Error("generation setup reservation rejected");
  private reservations = 0;

  /** 只拒绝第二次申请，使夹具在持有 scope 额度时进入 setup 失败路径。 */
  override reserve(pool: ServerPoolName, bytes: number) {
    this.reservations += 1;
    if (this.reservations === 2) throw this.setupError;
    return super.reserve(pool, bytes);
  }
}

// 调用者拿不到 dispose 的 setup 失败也必须释放 scope，并保留原始异常。
test("路由重放夹具在第二次预留失败时释放首次 scope 额度", async () => {
  const admission = new SetupFailureAdmission(DEFAULT_SYNC_CAPACITY);
  const before = usage(admission);
  await expect(routeReplayFixture("runtime", admission)).rejects.toBe(admission.setupError);
  expect(usage(admission)).toEqual(before);
});

// 共享控制器中的外部预留不属于夹具，关闭只需归还夹具自行取得的额度。
test("路由重放夹具关闭后保留调用者的既有预留", async () => {
  const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
  const outside = admission.reserve("controlIndex", 37);
  try {
    const f = await routeReplayFixture("runtime", admission);
    f.dispose();
    expect(admission.used("controlIndex")).toBe(37);
    expect(Object.values(usage(admission)).filter((bytes) => bytes !== 0)).toEqual([37]);
  } finally {
    outside.release();
  }
  expect(Object.values(usage(admission)).every((bytes) => bytes === 0)).toBe(true);
});

// 调用者可提前归还外部额度，夹具不得把 setup 时的池用量当作自己的清理基线。
test("共享控制器外部预留提前释放后夹具仍能正常关闭", async () => {
  const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
  const outside = admission.reserve("controlIndex", 37);
  const f = await routeReplayFixture("runtime", admission);
  try {
    outside.release();
    f.dispose();
    expect(Object.values(usage(admission)).every((bytes) => bytes === 0)).toBe(true);
  } finally {
    outside.release();
    f.store.dispose();
  }
});
