import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfig } from "../config";
import { _deps, _resetDeps, ensureSystemAdmin } from "../services/system-admin";

describe("ensureSystemAdmin", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fenix-system-admin-"));
    setConfig({ systemAdminPasswordFile: join(tempDir, "password.txt") });
    _resetDeps();
  });

  afterEach(() => {
    _resetDeps();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // 首次启动需要创建 admin 用户、admin 组织，并把密码写到文件中。
  test("creates system admin account and writes password file on first boot", async () => {
    _deps.findUserByEmail = mock(async () => null);
    _deps.generateSystemAdminPassword = mock(() => "ABCDEFGHIJKLMNOP");
    _deps.createSystemAdminRecords = mock(async () => ({
      userId: "user_admin",
      organizationId: "org_admin",
    }));

    const result = await ensureSystemAdmin();

    expect(result).toEqual({
      created: true,
      userId: "user_admin",
      email: "admin@fenix.com",
      organization: {
        id: "org_admin",
        slug: "admin",
      },
    });
    expect(existsSync(join(tempDir, "password.txt"))).toBe(true);
    expect(readFileSync(join(tempDir, "password.txt"), "utf-8")).toContain("password: ABCDEFGHIJKLMNOP");
  });

  // 同一邮箱已存在时必须完全跳过，不能修复、重置或覆盖密码文件。
  test("skips when admin user already exists", async () => {
    _deps.findUserByEmail = mock(async () => ({ id: "user_admin", email: "admin@fenix.com" }));
    _deps.findAdminOrganizationForUser = mock(async () => ({
      organizationId: "org_admin",
      slug: "admin",
    }));
    const createSpy = mock(async () => ({ userId: "new_user", organizationId: "new_org" }));
    const passwordSpy = mock(() => "ZZZZZZZZZZZZZZZZ");
    const writeSpy = mock((_password: string) => {});
    _deps.createSystemAdminRecords = createSpy;
    _deps.generateSystemAdminPassword = passwordSpy;
    _deps.writePasswordFile = writeSpy;

    const result = await ensureSystemAdmin();

    expect(result).toEqual({
      created: false,
      userId: "user_admin",
      email: "admin@fenix.com",
      organization: {
        id: "org_admin",
        slug: "admin",
      },
    });
    expect(createSpy).not.toHaveBeenCalled();
    expect(passwordSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
