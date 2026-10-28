import { describe, expect, test } from "bun:test";
import { CloudDriveError, notConfiguredError } from "../server/client/cloud-drive-error";
import type { CloudDriveGateway } from "../server/client/cloud-drive-gateway";
import { createCloudDriveFacade } from "../server/facades/cloud-drive-facade";
import { fakeGateway, makeFile, makeMutation, makeUpload } from "./cloud-drive-fixtures";

const USER_A = { userId: "user-a" };
const USER_B = { userId: "user-b" };

function facadeWith(gateway: CloudDriveGateway, options: { onUnexpectedError?: (error: unknown) => void } = {}) {
  return createCloudDriveFacade({
    resolveGateway: () => gateway,
    onUnexpectedError: options.onUnexpectedError,
  });
}

describe("CloudDrive Facade", () => {
  // 两个会话用户各自只看到自己的结果：Facade 必须把 actor.userId 原样作为 subject 交给网关。
  test("不同 actor 的请求使用各自的 subject，结果不串用户", async () => {
    const subjects: string[] = [];
    const gateway = fakeGateway({
      listFiles: async (subject) => {
        subjects.push(subject);
        return { items: [makeFile({ name: `${subject}.txt` })], nextCursor: null };
      },
    });
    const facade = facadeWith(gateway);

    const first = await facade.listFiles(USER_A, {});
    const second = await facade.listFiles(USER_B, {});

    expect(subjects).toEqual(["user-a", "user-b"]);
    expect(first.ok && first.data.items[0]?.name).toBe("user-a.txt");
    expect(second.ok && second.data.items[0]?.name).toBe("user-b.txt");
  });

  // 缺少会话主体时不得落到「匿名访问」：必须直接失败，且不触达网关。
  test("缺少 userId 时拒绝执行且不调用网关", async () => {
    let called = false;
    const gateway = fakeGateway({
      getMe: async () => {
        called = true;
        return { subject: "user-a", quota: { limitBytes: 1, usedBytes: 0, reservedBytes: 0, updatedAt: null } };
      },
    });
    const facade = facadeWith(gateway);

    const result = await facade.me({ userId: "   " });

    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe("CLOUD_DRIVE_ACTOR_REQUIRED");
  });

  // 改名/移动需要乐观并发值：Facade 先读元数据，再把 revision 与新名称/父目录一起提交。
  test("移动先读取元数据并把 revision 与幂等键传给网关", async () => {
    let received: Parameters<CloudDriveGateway["moveFile"]>[2] | undefined;
    const gateway = fakeGateway({
      getFile: async () => makeFile({ id: "file-1", name: "old.txt", parentId: "parent-1", metadataRevision: 7 }),
      moveFile: async (_subject, _fileId, input) => {
        received = input;
        return makeMutation();
      },
    });

    const result = await facadeWith(gateway).moveFile(USER_A, "file-1", { name: "new.txt", parentId: "parent-2" });

    expect(result.ok).toBe(true);
    expect(received?.name).toBe("new.txt");
    expect(received?.parentId).toBe("parent-2");
    expect(received?.expectedMetadataRevision).toBe(7);
    expect(received?.idempotencyKey.length).toBeGreaterThan(10);
  });

  // 名称与位置都没变时不应产生一次远端写操作。
  test("移动没有实际变化时返回 400 类错误且不调用网关写方法", async () => {
    let wrote = false;
    const gateway = fakeGateway({
      getFile: async () => makeFile({ name: "same.txt", parentId: "parent-1" }),
      moveFile: async () => {
        wrote = true;
        return makeMutation();
      },
    });

    const result = await facadeWith(gateway).moveFile(USER_A, "file-1", { name: "same.txt" });

    expect(wrote).toBe(false);
    expect(result.ok ? null : result.error.kind).toBe("invalid");
    expect(result.ok ? null : result.error.code).toBe("CLOUD_DRIVE_NO_CHANGE");
  });

  // 删除同样先读 revision；前端不需要自己维护元数据版本。
  test("删除先读取 revision 再提交", async () => {
    let received: Parameters<CloudDriveGateway["deleteFile"]>[2] | undefined;
    const gateway = fakeGateway({
      getFile: async () => makeFile({ metadataRevision: 11 }),
      deleteFile: async (_subject, _fileId, input) => {
        received = input;
        return makeMutation();
      },
    });

    const result = await facadeWith(gateway).deleteFile(USER_A, "file-1");

    expect(result.ok).toBe(true);
    expect(received?.expectedMetadataRevision).toBe(11);
  });

  // 覆盖写必须复用文件当前的名称/父目录/版本，否则 CloudDrive 会判 VERSION_CONFLICT 或拒绝移动。
  test("覆盖写上传复用当前名称、父目录、版本与 revision", async () => {
    let received: Parameters<CloudDriveGateway["beginUpload"]>[1] | undefined;
    const gateway = fakeGateway({
      getFile: async () =>
        makeFile({
          id: "file-1",
          name: "report.txt",
          parentId: "parent-1",
          contentType: "text/plain",
          currentVersionId: "version-9",
          metadataRevision: 3,
        }),
      beginUpload: async (_subject, input) => {
        received = input;
        return makeUpload();
      },
    });

    const result = await facadeWith(gateway).beginUpload(USER_A, {
      fileId: "file-1",
      sizeBytes: 42,
      contentType: "application/pdf",
    });

    expect(result.ok).toBe(true);
    expect(received).toMatchObject({
      fileId: "file-1",
      name: "report.txt",
      parentId: "parent-1",
      sizeBytes: 42,
      contentType: "application/pdf",
      expectedVersionId: "version-9",
      expectedMetadataRevision: 3,
    });
    expect(received?.idempotencyKey.length).toBeGreaterThan(10);
  });

  // 覆盖写不能借上传接口改名；这类请求在本地拒绝，避免一次注定失败的远端调用。
  test("覆盖写改名被拒绝", async () => {
    let began = false;
    const gateway = fakeGateway({
      getFile: async () => makeFile({ name: "report.txt" }),
      beginUpload: async () => {
        began = true;
        return makeUpload();
      },
    });

    const result = await facadeWith(gateway).beginUpload(USER_A, {
      fileId: "file-1",
      name: "renamed.txt",
      sizeBytes: 1,
    });

    expect(began).toBe(false);
    expect(result.ok ? null : result.error.code).toBe("CLOUD_DRIVE_OVERWRITE_NAME_MISMATCH");
  });

  // 回收站条目无法再被 GET /v1/files 读取，revision 只能由前端带回；缺失时必须明确拒绝。
  test("恢复回收站条目要求合法的 expectedMetadataRevision", async () => {
    let restored = false;
    const gateway = fakeGateway({
      restoreTrash: async () => {
        restored = true;
        return makeMutation();
      },
    });

    const result = await facadeWith(gateway).restoreTrash(USER_A, "trash-1", { expectedMetadataRevision: 0 });

    expect(restored).toBe(false);
    expect(result.ok ? null : result.error.kind).toBe("invalid");
    expect(result.ok ? null : result.error.code).toBe("CLOUD_DRIVE_REVISION_REQUIRED");
  });

  // 未配置 CloudDrive 时统一给 503 类失败，而不是抛异常打断请求处理。
  test("网关解析失败（未配置）收敛为 not-configured", async () => {
    const facade = createCloudDriveFacade({
      resolveGateway: () => {
        throw notConfiguredError();
      },
    });

    const result = await facade.me(USER_A);

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error).toEqual({
      kind: "not-configured",
      code: "CLOUD_DRIVE_NOT_CONFIGURED",
      message: "CloudDrive 未配置",
    });
  });

  // 上游错误原样收敛成失败分类，不改变 code 与文案。
  test("网关抛出的 CloudDriveError 原样成为失败结果", async () => {
    const gateway = fakeGateway({
      getFile: async () => {
        throw new CloudDriveError("not-found", "NOT_FOUND", "文件不存在或无权访问");
      },
    });

    const result = await facadeWith(gateway).getFile(USER_A, "missing");

    expect(result.ok ? null : result.error).toEqual({
      kind: "not-found",
      code: "NOT_FOUND",
      message: "文件不存在或无权访问",
    });
  });

  // 非 CloudDriveError 属于编程错误：必须上报并对外收敛为通用上游失败（不外泄堆栈）。
  test("意外异常上报并收敛为通用上游失败", async () => {
    const reported: unknown[] = [];
    const gateway = fakeGateway({
      getMe: async () => {
        throw new TypeError("boom");
      },
    });

    const result = await facadeWith(gateway, {
      onUnexpectedError: (error) => reported.push(error),
    }).me(USER_A);

    expect(reported).toHaveLength(1);
    expect(result.ok ? null : result.error).toEqual({
      kind: "upstream",
      code: "CLOUD_DRIVE_UPSTREAM_ERROR",
      message: "CloudDrive 调用失败",
    });
  });

  // 分片参数在 Facade 再校验一次：offset 非负整数、分片非空。
  test("非法分片参数被拒绝且不调用网关", async () => {
    const gateway = fakeGateway({
      patchUpload: async () => {
        throw new Error("不应被调用");
      },
    });
    const facade = facadeWith(gateway);

    const negative = await facade.uploadChunk(USER_A, "upload-1", { offset: -1, chunk: new Uint8Array([1]) });
    const empty = await facade.uploadChunk(USER_A, "upload-1", { offset: 0, chunk: new Uint8Array() });

    expect(negative.ok ? null : negative.error.code).toBe("CLOUD_DRIVE_OFFSET_INVALID");
    expect(empty.ok ? null : empty.error.code).toBe("CLOUD_DRIVE_CHUNK_EMPTY");
  });

  // 每次写操作生成不同的幂等键：同一请求重放不得复用上一个操作的身份。
  test("连续两次建目录生成不同幂等键", async () => {
    const keys: string[] = [];
    const gateway = fakeGateway({
      createDirectory: async (_subject, input) => {
        keys.push(input.idempotencyKey);
        return makeMutation();
      },
    });
    const facade = facadeWith(gateway);

    await facade.createDirectory(USER_A, { name: "a" });
    await facade.createDirectory(USER_A, { name: "b" });

    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
