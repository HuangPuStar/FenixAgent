import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotFoundError } from "@fenix/platform-sdk";
import { stubIdentityDirectory } from "@fenix/platform-sdk/testing";
import { createEditingFileAccess } from "../editing/file-access-adapter";
import { resolveWorkspacePath } from "../services/workspace-fs";
import {
  initializeMachineModuleConfig,
  lockMachineWorkspaceRoot,
  stubMachineEnvironment,
  unlockMachineWorkspaceRoot,
} from "../testing";

const scope = { organizationId: "org-edit", userId: "user-edit", environmentId: "env-edit" };
const files = createEditingFileAccess();
let directory: string;
let target: string;
beforeEach(async () => {
  initializeMachineModuleConfig();
  stubIdentityDirectory({ listMemberships: async () => [{ organizationId: scope.organizationId, role: "member" }] });
  const record = { id: scope.environmentId, organizationId: scope.organizationId, userId: scope.userId };
  stubMachineEnvironment({
    getEnvironmentById: async () => record,
    async getOwnedEnvironment(id, organizationId, userId) {
      if (id !== record.id || organizationId !== record.organizationId || userId !== record.userId)
        throw new NotFoundError("环境不存在");
      return record;
    },
  });
  directory = await mkdtemp(join(tmpdir(), "editing-adapter-"));
  await lockMachineWorkspaceRoot(directory);
  target = (await resolveWorkspacePath(scope.environmentId, "user/a.xlsx"))!.resolved;
  await writeFile(target, new Uint8Array([0, 255, 3, 5]));
});
afterEach(async () => {
  unlockMachineWorkspaceRoot();
  await rm(directory, { recursive: true, force: true });
});

// Office 端口必须读取相同字节的版本，保存经现有上传覆盖并返回真正提交的版本。
test("binary adapter round-trips exact bytes using a conditional upload", async () => {
  const snapshot = await files.readSnapshot(scope, "user/a.xlsx");
  expect([...snapshot.bytes]).toEqual([0, 255, 3, 5]);
  expect(snapshot.version).toBe(createHash("sha256").update(snapshot.bytes).digest("hex"));
  const next = new Uint8Array([4, 0, 255, 6]);
  const saved = await files.upload(scope, "user/a.xlsx", next, {
    expectedVersion: snapshot.version,
    opId: crypto.randomUUID(),
  });
  expect(saved.version).toBe(createHash("sha256").update(next).digest("hex"));
  expect(await readFile(target)).toEqual(Buffer.from(next));
  await expect(
    files.upload(scope, "user/a.xlsx", snapshot.bytes, {
      expectedVersion: snapshot.version,
      opId: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "conflict" });
});

// 回调保存不能依赖创建会话时的授权快照，组织或属主不匹配时每次操作都拒绝。
test("file adapter reauthorizes all operations and cannot recreate deleted conditional targets", async () => {
  const snapshot = await files.readSnapshot(scope, "user/a.xlsx");
  await expect(files.stat({ ...scope, organizationId: "other-org" }, "user/a.xlsx")).rejects.toMatchObject({
    code: "forbidden",
  });
  await expect(files.readSnapshot({ ...scope, userId: "other-user" }, "user/a.xlsx")).rejects.toMatchObject({
    code: "not-found",
  });
  await expect(
    files.upload({ ...scope, userId: "other-user" }, "user/a.xlsx", snapshot.bytes, {
      expectedVersion: snapshot.version,
      opId: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "not-found" });
  await rm(target);
  await expect(
    files.upload(scope, "user/a.xlsx", snapshot.bytes, {
      expectedVersion: snapshot.version,
      opId: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(await Bun.file(target).exists()).toBe(false);
});

// 已签名的 Office 引用也要恢复实时成员关系，移出组织后不可继续读取或写回。
test("provider file access rejects revoked organization membership", async () => {
  const snapshot = await files.readSnapshot(scope, "user/a.xlsx");
  stubIdentityDirectory({ listMemberships: async () => [] });
  await expect(files.authorize(scope)).rejects.toMatchObject({ code: "forbidden" });
  await expect(files.readSnapshot(scope, "user/a.xlsx")).rejects.toMatchObject({ code: "forbidden" });
  await expect(
    files.upload(scope, "user/a.xlsx", snapshot.bytes, {
      expectedVersion: snapshot.version,
      opId: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(await readFile(target)).toEqual(Buffer.from(snapshot.bytes));
});
