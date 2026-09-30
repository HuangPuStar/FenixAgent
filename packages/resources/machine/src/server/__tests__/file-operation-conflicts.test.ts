import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stubDb } from "@fenix/platform-sdk/testing";
import { type MachineFileActor, machineFileFacade } from "../facades/machine-file-facade";
import type { UploadFileInput } from "../services/file-types";
import { setDirectoryRenameBeforeMoveHookForTest } from "../services/workspace-fs";
import {
  initializeMachineModuleConfig,
  lockMachineWorkspaceRoot,
  stubFileWsTransport,
  stubMachineConfig,
  stubMachineEnvironmentRecord,
  unlockMachineWorkspaceRoot,
} from "../testing";

const ORG_ID = "org-conflicts";
const USER_ID = "user-conflicts";
const ENV_ID = "env-conflicts";
const MACHINE_ID = "machine-conflicts";
const ACTOR: MachineFileActor = { organizationId: ORG_ID, userId: USER_ID, role: "owner" };
let workspaceRoot: string;

function uploadFile(name: string, content: string): UploadFileInput {
  return { name, content: Buffer.from(content) };
}

beforeEach(async () => {
  initializeMachineModuleConfig();
  stubMachineEnvironmentRecord({ id: ENV_ID, organizationId: ORG_ID, userId: USER_ID });
  workspaceRoot = await mkdtemp(join(tmpdir(), "file-conflicts-"));
  await lockMachineWorkspaceRoot(workspaceRoot);
});

afterEach(async () => {
  setDirectoryRenameBeforeMoveHookForTest();
  unlockMachineWorkspaceRoot();
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe("文件操作冲突保护", () => {
  // 搬迁前故障只能清理自己新建的空占位，源目录与内容必须仍然完整。
  test("目录搬迁失败清理自己的空占位", async () => {
    const fs = await machineFileFacade.open(ACTOR, ENV_ID);
    await fs.write("source/item.txt", "source");
    setDirectoryRenameBeforeMoveHookForTest(async () => {
      throw new Error("injected before-move failure");
    });
    await expect(fs.rename("source", "target")).rejects.toMatchObject({ statusCode: 503 });
    await expect(fs.stat("target")).rejects.toMatchObject({ statusCode: 404 });
    expect(await fs.read("source/item.txt", "text")).toMatchObject({ content: "source" });
  });

  // 目录占位在rename前被并发填入内容时返回409，清理不得递归删除新增内容。
  test("目录占位被填入内容后保留双方", async () => {
    const fs = await machineFileFacade.open(ACTOR, ENV_ID);
    await fs.write("source/item.txt", "source");
    setDirectoryRenameBeforeMoveHookForTest(async (destination) => {
      await writeFile(join(destination, "concurrent.txt"), "concurrent");
    });
    await expect(fs.rename("source", "target")).rejects.toMatchObject({ type: "path_conflict", statusCode: 409 });
    expect(await fs.read("source/item.txt", "text")).toMatchObject({ content: "source" });
    expect(await fs.read("target/concurrent.txt", "text")).toMatchObject({ content: "concurrent" });
  });

  // 同名重命名和移动必须原子拒绝占用目标，源与目标字节均保持不变。
  test("rename 冲突保留双方内容", async () => {
    const fs = await machineFileFacade.open(ACTOR, ENV_ID);
    await fs.write("source.txt", "source");
    await fs.write("nested/target.txt", "target");
    await expect(fs.rename("source.txt", "nested/target.txt")).rejects.toMatchObject({
      type: "path_conflict",
      statusCode: 409,
    });
    expect(await fs.read("source.txt", "text")).toMatchObject({ content: "source" });
    expect(await fs.read("nested/target.txt", "text")).toMatchObject({ content: "target" });
  });

  // 目录先排他占用目标，已有目录（包括空目录）必须冲突且双方内容不变。
  test("目录 rename 拒绝已有目标且可移动到新目标", async () => {
    const fs = await machineFileFacade.open(ACTOR, ENV_ID);
    await fs.write("source/item.txt", "source");
    await fs.write("target/item.txt", "target");
    await expect(fs.rename("source", "target")).rejects.toMatchObject({ type: "path_conflict", statusCode: 409 });
    expect(await fs.read("source/item.txt", "text")).toMatchObject({ content: "source" });
    expect(await fs.read("target/item.txt", "text")).toMatchObject({ content: "target" });
    await fs.mkdir("empty");
    await expect(fs.rename("source", "empty")).rejects.toMatchObject({ type: "path_conflict", statusCode: 409 });
    expect(await fs.list("empty")).toEqual([]);
    await fs.rename("source", "new-parent/moved");
    expect(await fs.read("new-parent/moved/item.txt", "text")).toMatchObject({ content: "source" });
    await expect(fs.stat("source")).rejects.toMatchObject({ statusCode: 404 });
  });

  // wx 排他创建使重复上传拒绝覆盖，竞态批次只能有一个成功写入。
  test("并发与重复上传同名文件只能一个成功", async () => {
    const fs = await machineFileFacade.open(ACTOR, ENV_ID);
    const results = await Promise.allSettled([
      fs.upload("uploads", [uploadFile("same.txt", "first")]),
      fs.upload("uploads", [uploadFile("same.txt", "second")]),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({
      type: "path_conflict",
      statusCode: 409,
    });
    const original = await readFile(join(workspaceRoot, ORG_ID, USER_ID, ENV_ID, "uploads/same.txt"), "utf8");
    expect(["first", "second"]).toContain(original);
    await expect(fs.upload("uploads", [uploadFile("same.txt", "replacement")])).rejects.toMatchObject({
      type: "path_conflict",
      statusCode: 409,
    });
    expect(await readFile(join(workspaceRoot, ORG_ID, USER_ID, ENV_ID, "uploads/same.txt"), "utf8")).toBe(original);
  });

  // 两个源同时争用同名移动目标，只有赢家移除源文件，失败源仍可读取。
  test("并发 rename 排他占用目标", async () => {
    const fs = await machineFileFacade.open(ACTOR, ENV_ID);
    await fs.write("first.txt", "first");
    await fs.write("second.txt", "second");
    const results = await Promise.allSettled([
      fs.rename("first.txt", "target.txt"),
      fs.rename("second.txt", "target.txt"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = results[0].status === "fulfilled" ? "first" : "second";
    const loser = winner === "first" ? "second" : "first";
    expect(await fs.read("target.txt", "text")).toMatchObject({ content: winner });
    expect(await fs.read(`${loser}.txt`, "text")).toMatchObject({ content: loser });
  });

  // 机器端409必须保留领域分类，不得降级为503或泄露远程错误原文。
  test("远程上传与重命名冲突透传409", async () => {
    stubMachineConfig({ defaultMachineId: MACHINE_ID });
    stubDb({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: MACHINE_ID }] }) }) }) });
    stubFileWsTransport({
      isFileWsConnected: () => true,
      sendFileOpAndWait: async () => ({
        status: "error",
        error: "private remote path",
        errorCode: "path_conflict",
        statusCode: 409,
      }),
    });
    const fs = await machineFileFacade.open(ACTOR, ENV_ID);
    await expect(fs.rename("source.txt", "target.txt")).rejects.toMatchObject({
      type: "path_conflict",
      statusCode: 409,
    });
    await expect(fs.upload("uploads", [uploadFile("same.txt", "replacement")])).rejects.toMatchObject({
      type: "path_conflict",
      statusCode: 409,
    });
  });
});
