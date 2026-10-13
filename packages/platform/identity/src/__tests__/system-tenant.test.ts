/**
 * 系统托管租户只读解析测试（F4）。
 *
 * 断言 `IdentityDirectory.resolveSystemTenant()` 这条读路径**不含写副作用**：引导侧的依赖
 * （建号、写凭据文件、收紧凭据文件权限）在任何分支上都必须是零调用——否则「未初始化」与
 * 「首次初始化」又被同一个入口混为一谈，调用方无法判断调用成本与副作用。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _deps, _resetDeps, SYSTEM_ADMIN_EMAIL } from "../services/ensure-system-admin";
import { createIdentityDirectory } from "../services/identity-directory";

/** 引导侧写依赖的调用统计：读入口一旦触发其中任何一个，计数就会非零。 */
interface BootstrapWriteSpies {
  createRecords: ReturnType<typeof mock>;
  preparePasswordFile: ReturnType<typeof mock>;
  securePasswordFile: ReturnType<typeof mock>;
  generatePassword: ReturnType<typeof mock>;
}

/** 把引导侧的写依赖全部替换成替身（调用即计数），读入口不应触碰其中任何一个。 */
function spyOnBootstrapWrites(): BootstrapWriteSpies {
  const createRecords = mock(async () => ({ userId: "user_created", organizationId: "org_created" }));
  const preparePasswordFile = mock(() => ({ password: "ABCDEFGHIJKLMNOP" }));
  const securePasswordFile = mock(() => {});
  const generatePassword = mock(() => "ABCDEFGHIJKLMNOP");
  _deps.createSystemAdminRecords = createRecords;
  _deps.preparePasswordFile = preparePasswordFile;
  _deps.secureExistingPasswordFile = securePasswordFile;
  _deps.generateSystemAdminPassword = generatePassword;
  return { createRecords, preparePasswordFile, securePasswordFile, generatePassword };
}

/** 断言引导侧写依赖零调用。 */
function expectNoBootstrapWrites(spies: BootstrapWriteSpies): void {
  expect(spies.createRecords).not.toHaveBeenCalled();
  expect(spies.preparePasswordFile).not.toHaveBeenCalled();
  expect(spies.securePasswordFile).not.toHaveBeenCalled();
  expect(spies.generatePassword).not.toHaveBeenCalled();
}

describe("IdentityDirectory.resolveSystemTenant 只读语义", () => {
  beforeEach(() => {
    _resetDeps();
  });

  afterEach(() => {
    _resetDeps();
  });

  // 未引导（admin 账号不存在）时读入口必须抛错，且不得顺手把首次启动引导做掉
  test("未引导时抛错且不触发任何引导写操作", async () => {
    const spies = spyOnBootstrapWrites();
    const findUser = mock(async () => null);
    _deps.findUserByEmail = findUser;

    await expect(createIdentityDirectory().resolveSystemTenant()).rejects.toThrow("system tenant is not bootstrapped");

    expect(findUser).toHaveBeenCalledWith(SYSTEM_ADMIN_EMAIL);
    expectNoBootstrapWrites(spies);
  });

  // 已引导时返回真实租户，且不像引导那样反复收紧凭据文件权限（读入口不再 fchmod）
  test("已引导时返回租户且不写凭据文件", async () => {
    const spies = spyOnBootstrapWrites();
    _deps.findUserByEmail = mock(async () => ({ id: "user_admin" }));
    _deps.findAdminOrganizationForUser = mock(async () => ({ organizationId: "org_admin", slug: "admin" }));

    await expect(createIdentityDirectory().resolveSystemTenant()).resolves.toEqual({
      organizationId: "org_admin",
      organizationSlug: "admin",
      userId: "user_admin",
      email: SYSTEM_ADMIN_EMAIL,
    });

    expectNoBootstrapWrites(spies);
  });

  // 账号存在但 admin 组织归属缺失属于不一致状态：读入口抛错而不是静默返回空值或补建归属
  test("admin 组织归属缺失时抛错且无写副作用", async () => {
    const spies = spyOnBootstrapWrites();
    _deps.findUserByEmail = mock(async () => ({ id: "user_admin" }));
    _deps.findAdminOrganizationForUser = mock(async () => null);

    await expect(createIdentityDirectory().resolveSystemTenant()).rejects.toThrow("system tenant is inconsistent");

    expectNoBootstrapWrites(spies);
  });

  // 并发首次调用（多个请求同时解析租户）不得各自触发一次引导：全部失败且写依赖零调用
  test("并发首次调用全部抛错且不产生并发引导", async () => {
    const spies = spyOnBootstrapWrites();
    _deps.findUserByEmail = mock(async () => null);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => createIdentityDirectory().resolveSystemTenant()),
    );

    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expectNoBootstrapWrites(spies);
  });
});
