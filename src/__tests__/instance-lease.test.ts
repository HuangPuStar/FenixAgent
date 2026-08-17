/**
 * instance-lease 模块单测（C-P1.1-R）。
 *
 * 验证实例租约计数语义：acquire 占租约、release 配对归还、cleanup 守卫依赖的
 * hasActiveInstanceLease、测试隔离用 clearInstanceLeases。纯模块单测，直接用真实
 * 模块，不 mock。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  acquireInstanceLease,
  clearInstanceLeases,
  hasActiveInstanceLease,
  releaseInstanceLease,
} from "../services/workflow/instance-lease";

describe("instance-lease", () => {
  beforeEach(() => {
    clearInstanceLeases();
  });

  afterEach(() => {
    clearInstanceLeases();
  });

  // acquire 后实例处于活跃租约状态，cleanup 将跳过停止
  test("acquire 后 hasActiveInstanceLease 为 true", () => {
    acquireInstanceLease("inst_A");
    expect(hasActiveInstanceLease("inst_A")).toBe(true);
  });

  // 两个 run 共享实例时，释放一次租约后仍活跃（防止创建者先结束连坐使用者）
  test("两个 run 共享：释放一次后仍活跃，全部释放后失效", () => {
    acquireInstanceLease("inst_A");
    acquireInstanceLease("inst_A");
    releaseInstanceLease("inst_A");
    expect(hasActiveInstanceLease("inst_A")).toBe(true);
    releaseInstanceLease("inst_A");
    expect(hasActiveInstanceLease("inst_A")).toBe(false);
  });

  // 未知实例 release 幂等不抛错（已归零/外部停止的实例重复释放无害）
  test("未知实例 release 幂等不抛错", () => {
    expect(() => releaseInstanceLease("inst_unknown")).not.toThrow();
  });

  // clearInstanceLeases 清空全部租约（测试隔离，生产路径不调用）
  test("clearInstanceLeases 清空全部租约", () => {
    acquireInstanceLease("inst_A");
    acquireInstanceLease("inst_B");
    clearInstanceLeases();
    expect(hasActiveInstanceLease("inst_A")).toBe(false);
    expect(hasActiveInstanceLease("inst_B")).toBe(false);
  });
});
