import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _deps, _resetDeps, ensureSystemAdmin } from "../services/ensure-system-admin";

describe("ensureSystemAdmin", () => {
  let tempDir = "";

  const buildCredentialContent = (password: string, email = "admin@fenix.com") =>
    [
      "system admin account",
      "username: admin",
      `email: ${email}`,
      `password: ${password}`,
      "organization: admin",
      "",
    ].join("\n");

  const hashFile = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fenix-system-admin-"));
    _resetDeps();
    // 必须在 _resetDeps() 之后：配置读取已并入 _deps，复位会把路径还原成生产默认值，
    // 测试将在进程 cwd 下写出真实凭据文件。
    _deps.getConfig = () => ({ systemAdminPasswordFile: join(tempDir, "password.txt") });
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
    expect(statSync(join(tempDir, "password.txt")).mode & 0o777).toBe(0o600);
  });

  // 凭据文件无法安全写入时不能创建数据库账号，避免产生无法登录的 admin。
  test("does not create system admin records when credential file preparation fails", async () => {
    _deps.findUserByEmail = mock(async () => null);
    _deps.preparePasswordFile = mock(() => {
      throw new Error("credential file unavailable");
    });
    const createSpy = mock(async () => ({ userId: "user_admin", organizationId: "org_admin" }));
    _deps.createSystemAdminRecords = createSpy;

    await expect(ensureSystemAdmin()).rejects.toThrow("credential file unavailable");

    expect(createSpy).not.toHaveBeenCalled();
  });

  // 崩溃后已发布但尚未建库的凭据必须复用于账号创建，且文件内容不能变化。
  test("recovers system admin creation from a stale published credential file", async () => {
    const passwordFile = join(tempDir, "password.txt");
    const content = buildCredentialContent("STALEPASS1234567");
    writeFileSync(passwordFile, content, { mode: 0o644 });
    _deps.findUserByEmail = mock(async () => null);
    const createSpy = mock(async (password: string) => {
      expect(password).toBe("STALEPASS1234567");
      return { userId: "user_admin", organizationId: "org_admin" };
    });
    _deps.createSystemAdminRecords = createSpy;

    await expect(ensureSystemAdmin()).resolves.toMatchObject({ created: true });

    expect(readFileSync(passwordFile, "utf8")).toBe(content);
    expect(statSync(passwordFile).mode & 0o777).toBe(0o600);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  // 非固定格式的遗留凭据必须明确拒绝，不能覆盖文件或尝试创建账号。
  test("rejects malformed stale credential files without creating records", async () => {
    const passwordFile = join(tempDir, "password.txt");
    writeFileSync(passwordFile, "credential from another bootstrap\n", { mode: 0o600 });
    _deps.findUserByEmail = mock(async () => null);
    const createSpy = mock(async () => ({ userId: "user_admin", organizationId: "org_admin" }));
    _deps.createSystemAdminRecords = createSpy;

    await expect(ensureSystemAdmin()).rejects.toThrow("Existing system admin credential file is invalid");

    expect(readFileSync(passwordFile, "utf8")).toBe("credential from another bootstrap\n");
    expect(createSpy).not.toHaveBeenCalled();
  });

  // 遗留凭据声明其他邮箱时必须拒绝，避免将错误身份的密码用于系统 admin。
  test("rejects stale credential files for a different email", async () => {
    const passwordFile = join(tempDir, "password.txt");
    const content = buildCredentialContent("STALEPASS1234567", "other@example.com");
    writeFileSync(passwordFile, content, { mode: 0o600 });
    _deps.findUserByEmail = mock(async () => null);
    const createSpy = mock(async () => ({ userId: "user_admin", organizationId: "org_admin" }));
    _deps.createSystemAdminRecords = createSpy;

    await expect(ensureSystemAdmin()).rejects.toThrow("Existing system admin credential file is invalid");

    expect(readFileSync(passwordFile, "utf8")).toBe(content);
    expect(createSpy).not.toHaveBeenCalled();
  });

  // 符号链接即使指向合法凭据也必须拒绝，且不能修改引用目标的内容或权限。
  test("rejects a symlink credential intent without changing its referent", async () => {
    const passwordFile = join(tempDir, "password.txt");
    const referentPath = join(tempDir, "referent.txt");
    const content = buildCredentialContent("STALEPASS1234567");
    writeFileSync(referentPath, content, { mode: 0o644 });
    chmodSync(referentPath, 0o644);
    symlinkSync(referentPath, passwordFile);
    _deps.findUserByEmail = mock(async () => null);
    const createSpy = mock(async () => ({ userId: "user_admin", organizationId: "org_admin" }));
    _deps.createSystemAdminRecords = createSpy;

    await expect(ensureSystemAdmin()).rejects.toThrow("must be a regular file");

    expect(createSpy).not.toHaveBeenCalled();
    expect(readFileSync(referentPath, "utf8")).toBe(content);
    expect(statSync(referentPath).mode & 0o777).toBe(0o644);
  });

  // lstat 后若普通文件被替换为 symlink，O_NOFOLLOW 必须在 open 阶段拒绝 TOCTOU。
  test("rejects a symlink replacement between credential lstat and open", async () => {
    const passwordFile = join(tempDir, "password.txt");
    const referentPath = join(tempDir, "referent.txt");
    const content = buildCredentialContent("STALEPASS1234567");
    writeFileSync(passwordFile, content, { mode: 0o600 });
    writeFileSync(referentPath, content, { mode: 0o644 });
    chmodSync(referentPath, 0o644);
    _deps.findUserByEmail = mock(async () => null);
    const createSpy = mock(async () => ({ userId: "user_admin", organizationId: "org_admin" }));
    _deps.createSystemAdminRecords = createSpy;
    let observedFlags = 0;
    const depsWithSecureOpen = _deps as typeof _deps & { openPasswordFile: (path: string, flags: number) => number };
    depsWithSecureOpen.openPasswordFile = (path: string, flags: number) => {
      observedFlags = flags;
      unlinkSync(path);
      symlinkSync(referentPath, path);
      return openSync(path, flags);
    };

    await expect(ensureSystemAdmin()).rejects.toThrow("Unable to securely open existing system admin credential file");

    expect(observedFlags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(createSpy).not.toHaveBeenCalled();
    expect(readFileSync(referentPath, "utf8")).toBe(content);
    expect(statSync(referentPath).mode & 0o777).toBe(0o644);
  });

  // lstat 后若普通文件被替换为 FIFO，O_NONBLOCK 必须让 open 返回并由 fstat 拒绝，不能阻塞或修改原文件。
  test("rejects a FIFO replacement between credential lstat and open without blocking", async () => {
    const passwordFile = join(tempDir, "password.txt");
    const movedFile = join(tempDir, "moved-password.txt");
    const content = buildCredentialContent("STALEPASS1234567");
    writeFileSync(passwordFile, content, { mode: 0o644 });
    chmodSync(passwordFile, 0o644);
    _deps.findUserByEmail = mock(async () => null);
    const createSpy = mock(async () => ({ userId: "user_admin", organizationId: "org_admin" }));
    _deps.createSystemAdminRecords = createSpy;
    let observedFlags = 0;
    const depsWithSecureOpen = _deps as typeof _deps & { openPasswordFile: (path: string, flags: number) => number };
    depsWithSecureOpen.openPasswordFile = (path: string, flags: number) => {
      observedFlags = flags;
      if ((flags & constants.O_NONBLOCK) !== constants.O_NONBLOCK) {
        throw new Error("credential open omitted O_NONBLOCK");
      }
      renameSync(path, movedFile);
      const mkfifo = Bun.spawnSync(["mkfifo", path]);
      if (mkfifo.exitCode !== 0) throw new Error("unable to create FIFO replacement");
      return openSync(path, flags);
    };

    await expect(
      Promise.race([
        ensureSystemAdmin(),
        Bun.sleep(2_000).then(() => {
          throw new Error("FIFO replacement check timed out");
        }),
      ]),
    ).rejects.toThrow("must be a regular file");

    expect(observedFlags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    expect(createSpy).not.toHaveBeenCalled();
    expect(readFileSync(movedFile, "utf8")).toBe(content);
    expect(statSync(movedFile).mode & 0o777).toBe(0o644);
    expect(lstatSync(passwordFile).isFIFO()).toBe(true);
  });

  // FIFO 不是普通文件，必须在任何可能阻塞的读取前快速拒绝且不调用 DB。
  test("rejects a FIFO credential intent without attempting to read it", async () => {
    const passwordFile = join(tempDir, "password.txt");
    const mkfifo = Bun.spawnSync(["mkfifo", passwordFile]);
    if (mkfifo.exitCode !== 0) return;
    _deps.findUserByEmail = mock(async () => null);
    const createSpy = mock(async () => ({ userId: "user_admin", organizationId: "org_admin" }));
    _deps.createSystemAdminRecords = createSpy;

    await expect(ensureSystemAdmin()).rejects.toThrow("must be a regular file");

    expect(createSpy).not.toHaveBeenCalled();
  });

  // 发布 hard-link 与删除临时目录项后都必须同步目标目录。
  test("syncs the credential directory after publication and temporary-file removal", async () => {
    _deps.findUserByEmail = mock(async () => null);
    _deps.generateSystemAdminPassword = mock(() => "ABCDEFGHIJKLMNOP");
    _deps.createSystemAdminRecords = mock(async () => ({ userId: "user_admin", organizationId: "org_admin" }));
    const syncDirectorySpy = mock((_path: string) => {});
    const depsWithDirectorySync = _deps as typeof _deps & { syncDirectory: (path: string) => void };
    depsWithDirectorySync.syncDirectory = syncDirectorySpy;

    await ensureSystemAdmin();

    expect(syncDirectorySpy.mock.calls.filter(([path]) => path === tempDir)).toEqual([[tempDir], [tempDir]]);
  });

  // 递归创建凭据目录时必须自上而下持久化每个新目录在父目录中的 dentry。
  test("syncs every parent directory created for a nested credential path", async () => {
    const firstLevel = join(tempDir, "level-one");
    const secondLevel = join(firstLevel, "level-two");
    const targetDir = join(secondLevel, "credentials");
    _deps.getConfig = () => ({ systemAdminPasswordFile: join(targetDir, "password.txt") });
    _deps.findUserByEmail = mock(async () => null);
    _deps.generateSystemAdminPassword = mock(() => "ABCDEFGHIJKLMNOP");
    _deps.createSystemAdminRecords = mock(async () => ({ userId: "user_admin", organizationId: "org_admin" }));
    const syncedDirectories: string[] = [];
    _deps.syncDirectory = (path: string) => syncedDirectories.push(path);

    await ensureSystemAdmin();

    const relevantDirectories = syncedDirectories.filter((path) =>
      [tempDir, firstLevel, secondLevel, targetDir].includes(path),
    );
    expect(relevantDirectories).toEqual([tempDir, firstLevel, secondLevel, targetDir, targetDir]);
    expect(existsSync(join(targetDir, "password.txt"))).toBe(true);
  });

  // 父层 dentry 同步失败时必须在写临时凭据和调用 DB 前终止，空目录可保留供排障。
  test("stops before credential publication when a created parent directory cannot be synced", async () => {
    const firstLevel = join(tempDir, "level-one");
    const targetDir = join(firstLevel, "level-two", "credentials");
    const passwordFile = join(targetDir, "password.txt");
    _deps.getConfig = () => ({ systemAdminPasswordFile: passwordFile });
    _deps.findUserByEmail = mock(async () => null);
    const createSpy = mock(async () => ({ userId: "user_admin", organizationId: "org_admin" }));
    _deps.createSystemAdminRecords = createSpy;
    _deps.syncDirectory = (path: string) => {
      if (path === firstLevel) throw new Error("directory sync unavailable");
    };

    await expect(ensureSystemAdmin()).rejects.toThrow("Unable to persist system admin credential directory hierarchy");

    expect(createSpy).not.toHaveBeenCalled();
    expect(existsSync(passwordFile)).toBe(false);
    expect(readdirSync(targetDir)).toEqual([]);
  });

  // 前次失败遗留的目录在重试时仍必须重做完整父链同步，成功后才能发布凭据并调用 DB。
  test("retries parent directory sync even when a previous attempt left the hierarchy in place", async () => {
    const firstLevel = join(tempDir, "level-one");
    const targetDir = join(firstLevel, "level-two", "credentials");
    const passwordFile = join(targetDir, "password.txt");
    _deps.getConfig = () => ({ systemAdminPasswordFile: passwordFile });
    _deps.findUserByEmail = mock(async () => null);
    const createSpy = mock(async () => ({ userId: "user_admin", organizationId: "org_admin" }));
    _deps.createSystemAdminRecords = createSpy;
    const syncedDirectories: string[] = [];
    let failFirstAttempt = true;
    _deps.syncDirectory = (path: string) => {
      syncedDirectories.push(path);
      if (path === firstLevel && failFirstAttempt) {
        failFirstAttempt = false;
        throw new Error("directory sync unavailable");
      }
    };

    await expect(ensureSystemAdmin()).rejects.toThrow("Unable to persist system admin credential directory hierarchy");
    expect(createSpy).not.toHaveBeenCalled();
    expect(existsSync(passwordFile)).toBe(false);

    await expect(ensureSystemAdmin()).resolves.toMatchObject({ created: true });

    expect(syncedDirectories.filter((path) => path === firstLevel)).toHaveLength(2);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  // 单实例建库失败后必须保留凭据意图，下次启动复用同一密码完成恢复。
  test("preserves a newly published credential file and reuses it after record creation fails", async () => {
    const passwordFile = join(tempDir, "password.txt");
    _deps.findUserByEmail = mock(async () => null);
    let generatedPasswordCalls = 0;
    _deps.generateSystemAdminPassword = mock(() =>
      generatedPasswordCalls++ === 0 ? "ABCDEFGHIJKLMNOP" : "QRSTUVWXYZabcdef",
    );
    const syncDirectorySpy = mock((_path: string) => {});
    const depsWithDirectorySync = _deps as typeof _deps & { syncDirectory: (path: string) => void };
    depsWithDirectorySync.syncDirectory = syncDirectorySpy;
    let createCalls = 0;
    _deps.createSystemAdminRecords = mock(async (password: string) => {
      createCalls += 1;
      if (createCalls === 1) throw new Error("database bootstrap failed");
      expect(password).toBe("ABCDEFGHIJKLMNOP");
      return { userId: "user_admin", organizationId: "org_admin" };
    });

    await expect(ensureSystemAdmin()).rejects.toThrow("credential intent was preserved for retry");
    const contentBeforeRetry = readFileSync(passwordFile, "utf8");
    const hashBeforeRetry = hashFile(passwordFile);

    await expect(ensureSystemAdmin()).resolves.toMatchObject({ created: true });

    expect(readFileSync(passwordFile, "utf8")).toBe(contentBeforeRetry);
    expect(hashFile(passwordFile)).toBe(hashBeforeRetry);
    expect(statSync(passwordFile).mode & 0o777).toBe(0o600);
    expect(syncDirectorySpy.mock.calls.filter(([path]) => path === tempDir)).toEqual([[tempDir], [tempDir]]);
  });

  // A 发布后 B 可复用同一凭据成功建库，A 随后的唯一约束失败不得删除共享意图文件。
  test("preserves the shared credential intent when a concurrent bootstrap loses the database race", async () => {
    const passwordFile = join(tempDir, "password.txt");
    _deps.findUserByEmail = mock(async () => null);
    _deps.generateSystemAdminPassword = mock(() => "ABCDEFGHIJKLMNOP");
    let rejectFirstBootstrap: ((error: Error) => void) | undefined;
    let firstPassword = "";
    let createCalls = 0;
    let markFirstBootstrapEntered: (() => void) | undefined;
    const firstBootstrapEntered = new Promise<void>((resolve) => {
      markFirstBootstrapEntered = resolve;
    });
    _deps.createSystemAdminRecords = mock((password: string) => {
      createCalls += 1;
      if (createCalls === 1) {
        firstPassword = password;
        markFirstBootstrapEntered?.();
        return new Promise<{ userId: string; organizationId: string }>((_resolve, reject) => {
          rejectFirstBootstrap = reject;
        });
      }
      expect(password).toBe(firstPassword);
      return Promise.resolve({ userId: "user_admin", organizationId: "org_admin" });
    });

    const firstBootstrap = ensureSystemAdmin();
    await Promise.race([
      firstBootstrapEntered,
      Bun.sleep(2_000).then(() => {
        throw new Error("first bootstrap did not reach record creation");
      }),
    ]);
    const contentAfterPublication = readFileSync(passwordFile, "utf8");
    const hashAfterPublication = hashFile(passwordFile);

    const secondBootstrap = ensureSystemAdmin();
    await expect(
      Promise.race([
        secondBootstrap,
        Bun.sleep(2_000).then(() => {
          throw new Error("second bootstrap did not complete record creation");
        }),
      ]),
    ).resolves.toMatchObject({ created: true });
    if (!rejectFirstBootstrap) throw new Error("first bootstrap reject callback was not captured");
    rejectFirstBootstrap(new Error("unique constraint violation"));
    await expect(firstBootstrap).rejects.toThrow("credential intent was preserved for retry");

    expect(existsSync(passwordFile)).toBe(true);
    expect(readFileSync(passwordFile, "utf8")).toBe(contentAfterPublication);
    expect(hashFile(passwordFile)).toBe(hashAfterPublication);
    expect(statSync(passwordFile).mode & 0o777).toBe(0o600);
  });

  // A 已公开 hard-link 后即失去 target 所有权；目录同步失败也不能删除 B 已读取并用于建库的共享 intent。
  test("preserves the shared credential intent when directory sync fails after publication", async () => {
    const passwordFile = join(tempDir, "password.txt");
    const password = "ABCDEFGHIJKLMNOP";
    _deps.findUserByEmail = mock(async () => null);
    _deps.generateSystemAdminPassword = mock(() => password);
    let createdPassword = "";
    const createSpy = mock(async (candidate: string) => {
      createdPassword = candidate;
      return { userId: "user_admin", organizationId: "org_admin" };
    });
    _deps.createSystemAdminRecords = createSpy;
    let concurrentRecordCreation: Promise<{ userId: string; organizationId: string }> | undefined;
    let targetDirectorySyncCalls = 0;
    _deps.syncDirectory = (path: string) => {
      if (path !== tempDir) return;
      targetDirectorySyncCalls += 1;
      if (targetDirectorySyncCalls === 1) {
        const concurrentFile = _deps.preparePasswordFile("QRSTUVWXYZabcdef");
        concurrentRecordCreation = _deps.createSystemAdminRecords(concurrentFile.password);
        throw new Error("directory sync unavailable after publication");
      }
    };

    let publicationError: unknown;
    try {
      await ensureSystemAdmin();
    } catch (error) {
      publicationError = error;
    }
    expect(publicationError).toBeInstanceOf(Error);
    expect((publicationError as Error).message).toContain("Unable to prepare system admin credential file");
    expect(JSON.stringify(publicationError)).not.toContain(password);
    if (!concurrentRecordCreation) throw new Error("concurrent bootstrap did not read the published intent");
    await expect(
      Promise.race([
        concurrentRecordCreation,
        Bun.sleep(2_000).then(() => {
          throw new Error("concurrent record creation did not finish");
        }),
      ]),
    ).resolves.toEqual({ userId: "user_admin", organizationId: "org_admin" });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createdPassword).toBe(password);
    expect(existsSync(passwordFile)).toBe(true);
    expect(hashFile(passwordFile)).toBe(createHash("sha256").update(buildCredentialContent(password)).digest("hex"));
    expect(readFileSync(passwordFile, "utf8")).toBe(buildCredentialContent(password));
    expect(statSync(passwordFile).mode & 0o777).toBe(0o600);
    expect(targetDirectorySyncCalls).toBe(2);
  });

  // 遗留凭据恢复时数据库失败必须保留文件，并提供不含密码的恢复错误供下次重试。
  test("preserves a stale credential file when recovery record creation fails", async () => {
    const passwordFile = join(tempDir, "password.txt");
    const password = "STALEPASS1234567";
    const content = buildCredentialContent(password);
    writeFileSync(passwordFile, content, { mode: 0o600 });
    _deps.findUserByEmail = mock(async () => null);
    _deps.createSystemAdminRecords = mock(async () => {
      throw new Error("database bootstrap failed");
    });

    let error: unknown;
    try {
      await ensureSystemAdmin();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("credential intent was preserved for retry");
    expect(JSON.stringify(error)).not.toContain(password);
    expect(readFileSync(passwordFile, "utf8")).toBe(content);
  });

  // 已有 admin 的凭据内容不能被覆盖，但宽松权限必须收紧为仅属主可读写。
  test("tightens existing credential file permissions without changing its content", async () => {
    const passwordFile = join(tempDir, "password.txt");
    writeFileSync(passwordFile, "existing credential content\n", { mode: 0o644 });
    chmodSync(passwordFile, 0o644);
    _deps.findUserByEmail = mock(async () => ({ id: "user_admin", email: "admin@fenix.com" }));
    _deps.findAdminOrganizationForUser = mock(async () => ({ organizationId: "org_admin", slug: "admin" }));

    await ensureSystemAdmin();

    expect(readFileSync(passwordFile, "utf8")).toBe("existing credential content\n");
    expect(statSync(passwordFile).mode & 0o777).toBe(0o600);
  });

  // 首次创建全过程的结构化日志参数都不得包含生成的初始密码。
  test("does not expose the generated password through bootstrap logger arguments", async () => {
    const generatedPassword = "PHY10_TEST_FIXED_CREDENTIAL";
    const capturedLogs: unknown[][] = [];
    _deps.findUserByEmail = mock(async () => null);
    _deps.generateSystemAdminPassword = mock(() => generatedPassword);
    _deps.createSystemAdminRecords = mock(async () => ({ userId: "user_admin", organizationId: "org_admin" }));
    _deps.logger = { info: (...args: unknown[]) => capturedLogs.push(args) };

    await ensureSystemAdmin();

    expect(JSON.stringify(capturedLogs)).not.toContain(generatedPassword);
    expect(JSON.stringify(capturedLogs)).toContain("admin@fenix.com");
  });

  // 同一邮箱已存在时不重置密码或覆盖凭据内容，仅允许收紧已有文件权限。
  test("skips when admin user already exists", async () => {
    _deps.findUserByEmail = mock(async () => ({ id: "user_admin", email: "admin@fenix.com" }));
    _deps.findAdminOrganizationForUser = mock(async () => ({
      organizationId: "org_admin",
      slug: "admin",
    }));
    const createSpy = mock(async () => ({ userId: "new_user", organizationId: "new_org" }));
    const passwordSpy = mock(() => "ZZZZZZZZZZZZZZZZ");
    _deps.createSystemAdminRecords = createSpy;
    _deps.generateSystemAdminPassword = passwordSpy;

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
  });
});
