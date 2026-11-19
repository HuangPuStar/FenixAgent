import { expect, test } from "bun:test";
import { AdmissionController, type ServerPoolName } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { adoptWorkingReservation, WORKING_CREDIT, WorkingCredit } from "../sync/capacity/working-credit";

/** 精确小池暴露共享承诺的加总关系，不依赖默认大池掩盖错误。 */
function controller(controlIndex = 200) {
  return new AdmissionController({
    ...DEFAULT_SYNC_CAPACITY,
    serverPools: { ...DEFAULT_SYNC_CAPACITY.serverPools, controlIndex },
  });
}

/** 真实额度申请边界可能执行同步生命周期回调，扩容不能假定申请期间 owner 不变。 */
class ReentrantAdmission extends AdmissionController {
  beforeReserve: (() => void) | null = null;
  override reserve(pool: ServerPoolName, bytes: number, credit?: WorkingCredit) {
    const before = this.beforeReserve;
    this.beforeReserve = null;
    before?.();
    return super.reserve(pool, bytes, credit);
  }
}

// 父窗口在reserve期间被关闭时，迟到额度必须立即退还，不能复活closed信用。
test("growTo 期间关闭不泄漏迟到 reservation", () => {
  const admission = new ReentrantAdmission(DEFAULT_SYNC_CAPACITY);
  const credit = admission.createWorkingCredit(64);
  admission.beforeReserve = () => credit.release();
  expect(() => credit.growTo(128)).toThrow("closed");
  expect(credit.availableBytes).toBe(0);
  credit.release();
  expect(admission.used("controlIndex")).toBe(0);
});

for (const nested of [96, 192]) {
  // 嵌套扩容只保留最新最大目标，既不重复扣差额，也不能用外层旧目标覆盖内层大目标。
  test(`growTo 同步嵌套 ${nested} 只保留最大已确认目标`, () => {
    const admission = new ReentrantAdmission(DEFAULT_SYNC_CAPACITY);
    const credit = admission.createWorkingCredit(64);
    admission.beforeReserve = () => credit.growTo(nested);
    try {
      credit.growTo(128);
      expect(credit.availableBytes).toBe(Math.max(128, nested));
      expect(admission.used("controlIndex")).toBe(Math.max(128, nested));
    } finally {
      credit.release();
    }
    expect(admission.used("controlIndex")).toBe(0);
  });
}

// 扩容中的同步缩容会使外层差额失真，必须拒绝而不是制造有账无额度的子信用。
test("growTo 期间同步shrink拒绝且原承诺不变", () => {
  const admission = new ReentrantAdmission(DEFAULT_SYNC_CAPACITY);
  const credit = admission.createWorkingCredit(64);
  admission.beforeReserve = () => credit.shrinkTo(32);
  expect(() => credit.growTo(128)).toThrow("cannot shrink during growth");
  expect(credit.totalBytes).toBe(64);
  expect(credit.availableBytes).toBe(64);
  credit.release();
  expect(admission.used("controlIndex")).toBe(0);
});

// 接纳撤回只收回空闲扩额，已借出的额度仍由其任务归还。
test("shrinkTo 仅撤回未借出的临时扩窗", () => {
  const admission = controller();
  const credit = admission.createWorkingCredit(64);
  credit.growTo(160);
  credit.shrinkTo(64);
  expect(admission.used("controlIndex")).toBe(64);
  const child = admission.reserve("controlIndex", 60, credit);
  expect(() => credit.shrinkTo(32)).toThrow("borrowed bytes");
  child.release();
  credit.release();
  expect(admission.used("controlIndex")).toBe(0);
});

// 两个scope的工作承诺真实相加，不能都在同一份200B空闲上通过150B的探测。
test("工作信用物理占池并阻止第二窗口重复承诺同一份额度", () => {
  const admission = controller();
  const credit = admission.createWorkingCredit(150);
  expect(admission.used("controlIndex")).toBe(150);
  expect(() => admission.createWorkingCredit(150)).toThrow("controlIndex");
  const committed = admission.reserve("controlIndex", 100, credit);
  adoptWorkingReservation(committed);
  credit.release();
  expect(admission.used("controlIndex")).toBe(100);
  expect(() => admission.createWorkingCredit(150)).toThrow("controlIndex");
  committed.release();
  expect(admission.used("controlIndex")).toBe(0);
});

// 事务准备失败归还原窗口而非全局空闲，下一次原attempt仍能取得完整子额度。
test("未发布子额度 abort 回流原信用且不被外部scope抢走", () => {
  const admission = controller();
  const credit = admission.createWorkingCredit(200);
  const first = admission.reserve("controlIndex", 150, credit);
  expect(admission.used("controlIndex")).toBe(200);
  first.release();
  first.release();
  expect(credit.availableBytes).toBe(200);
  expect(() => admission.reserve("controlIndex", 1)).toThrow("controlIndex");
  const replay = admission.reserve("controlIndex", 200, credit);
  replay.release();
  credit.release();
  expect(admission.used("controlIndex")).toBe(0);
});

// 关闭时借出的子额度仍属原任务，commit转常驻与abort归还都不能提前释放或重复扣账。
test("信用关闭后在途子额度仍可无失败地adopt并独立归还", () => {
  const admission = controller();
  const credit = admission.createWorkingCredit(200);
  const child = admission.reserve("controlIndex", 60, credit);
  credit.release();
  expect(admission.used("controlIndex")).toBe(60);
  adoptWorkingReservation(child);
  adoptWorkingReservation(child);
  child.release();
  child.release();
  expect(admission.used("controlIndex")).toBe(0);
  const plain = admission.reserve("controlIndex", 1);
  adoptWorkingReservation(plain);
  plain.release();
});

// 扩窗只计差额，扩窗失败不得损坏已接纳窗口原来可用的提交预算。
test("工作信用增量扩容失败保留原额度及全部子归属", () => {
  const admission = controller();
  const credit = admission.createWorkingCredit(100);
  credit.growTo(150);
  expect(admission.used("controlIndex")).toBe(150);
  expect(() => credit.growTo(250)).toThrow("controlIndex");
  expect(credit.availableBytes).toBe(150);
  const child = admission.reserve("controlIndex", 125, credit);
  child.release();
  credit.release();
  expect(admission.used("controlIndex")).toBe(0);
});

// 信用必须由同一个controller签发，结构相同的对象、外池借用及关闭后的信用都不能冒充额度。
test("拒绝foreign伪造和closed信用且禁止持久化JSON", () => {
  const admission = controller(),
    other = controller();
  const credit = admission.createWorkingCredit(100);
  expect(() => other.reserve("controlIndex", 1, credit)).toThrow("another controller");
  expect(() => other.reserve("hotDocLive", 1, credit)).toThrow("another controller");
  const fake = new WorkingCredit(
    admission.reserve("controlIndex", 1),
    () => {
      throw new Error("unused");
    },
    () => {
      throw new Error("unused");
    },
  );
  expect(() => admission.reserve("controlIndex", 1, fake)).toThrow("another controller");
  expect(() => JSON.stringify({ credit })).toThrow("cannot be serialized");
  fake.release();
  credit.release();
  expect(() => admission.reserve("controlIndex", 1, credit)).toThrow("closed");
  expect(() => admission.reserve("hotDocLive", 1, credit)).toThrow("closed");
  expect(admission.used("controlIndex")).toBe(0);
});

// 本地capability不能变成业务摘要或可移植记录，结构化复制仍可记录正常Store输入而不复制函数。
test("符号工作上下文不会进入JSON或structuredClone数据记录", () => {
  const admission = controller();
  const credit = admission.createWorkingCredit(100);
  const input = { batchId: "batch", digest: "digest", [WORKING_CREDIT]: credit };
  expect(JSON.stringify(input)).toBe(JSON.stringify({ batchId: "batch", digest: "digest" }));
  const portable: object = structuredClone(input);
  expect(portable).toEqual({ batchId: "batch", digest: "digest" });
  expect(Object.getOwnPropertySymbols(portable)).toEqual([]);
  expect({ ...input }[WORKING_CREDIT]).toBe(credit);
  credit.release();
  expect(admission.used("controlIndex")).toBe(0);
});
