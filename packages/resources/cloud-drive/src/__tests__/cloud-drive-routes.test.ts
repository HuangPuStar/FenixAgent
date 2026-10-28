import { describe, expect, test } from "bun:test";
import { readJson } from "@fenix/platform-sdk/testing";
import { CloudDriveError } from "../server/client/cloud-drive-error";
import type { CloudDriveGateway } from "../server/client/cloud-drive-gateway";
import { type CloudDriveContent, createCloudDriveFacade } from "../server/facades/cloud-drive-facade";
import type { SessionAuthContext } from "../server/routes/dependencies";
import { createWebCloudDriveRoutes } from "../server/routes/web/cloud-drive";
import {
  createStubSessionAuthGuardPlugin,
  fakeGateway,
  jsonInit,
  makeFile,
  makeMutation,
} from "./cloud-drive-fixtures";

const AUTH: SessionAuthContext = { userId: "user-a", organizationId: "org-1" };

function createApp(gateway: CloudDriveGateway, authContext: SessionAuthContext | null = AUTH) {
  const facade = createCloudDriveFacade({ resolveGateway: () => gateway });
  return createWebCloudDriveRoutes({
    authGuardPlugin: createStubSessionAuthGuardPlugin(authContext),
    facade,
  });
}

function request(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  return app.handle(new Request(`http://localhost${path}`, init));
}

function content(
  body: string,
  fileName = "report.txt",
  status = 200,
  headers: Record<string, string> = {},
): CloudDriveContent {
  return { response: new Response(body, { status, headers }), fileName };
}

describe("CloudDrive /web 路由", () => {
  // 每条端点都必须真正接上会话守卫：未认证时统一 401，缺一条 sessionAuth 声明即失败。
  test("未认证时全部端点返回 401", async () => {
    const app = createApp(fakeGateway({}), null);
    const chunkRequest = {
      method: "PATCH",
      headers: { "content-length": "1", "upload-offset": "0", "content-type": "application/offset+octet-stream" },
      body: new Uint8Array([1]),
    } satisfies RequestInit;
    const cases: Array<[string, RequestInit]> = [
      ["/cloud-drive/me", { method: "GET" }],
      ["/cloud-drive/files", { method: "GET" }],
      ["/cloud-drive/files/file-1", { method: "GET" }],
      ["/cloud-drive/files/file-1/versions", { method: "GET" }],
      ["/cloud-drive/files/file-1/content", { method: "GET" }],
      ["/cloud-drive/directories", jsonInit("POST", { name: "docs" })],
      ["/cloud-drive/files/file-1/location", jsonInit("PATCH", { name: "renamed.txt" })],
      ["/cloud-drive/files/file-1", { method: "DELETE" }],
      ["/cloud-drive/trash", { method: "GET" }],
      ["/cloud-drive/trash/trash-1/restore", jsonInit("POST", { expectedMetadataRevision: 1 })],
      ["/cloud-drive/search", jsonInit("POST", { query: "report" })],
      ["/cloud-drive/uploads", jsonInit("POST", { name: "report.txt", sizeBytes: 3 })],
      ["/cloud-drive/uploads/upload-1", { method: "GET" }],
      ["/cloud-drive/uploads/upload-1", chunkRequest],
      ["/cloud-drive/uploads/upload-1/finalize", { method: "POST" }],
      ["/cloud-drive/uploads/upload-1/abandon", { method: "POST" }],
    ];

    for (const [path, init] of cases) {
      const response = await request(app, path, init);
      expect([path, response.status]).toEqual([path, 401]);
    }
  });

  // actor 只来自会话：查询串里塞 userId 不会改变 X-On-Behalf-Of 的主体（这里断言 Facade 收到的 subject）。
  test("查询串中的 userId 不影响会话主体", async () => {
    const subjects: string[] = [];
    const app = createApp(
      fakeGateway({
        getMe: async (subject) => {
          subjects.push(subject);
          return { subject, quota: { limitBytes: 10, usedBytes: 1, reservedBytes: 0, updatedAt: null } };
        },
      }),
    );

    const response = await request(app, "/cloud-drive/me?userId=user-b");

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      success: true,
      data: { subject: "user-a", quota: { limitBytes: 10, usedBytes: 1, reservedBytes: 0, updatedAt: null } },
    });
    expect(subjects).toEqual(["user-a"]);
  });

  // 列表把 parentId/cursor 转给客户端，并把上游 DTO 包进 /web 成功信封。
  test("列表返回信封并透传分页参数", async () => {
    let received: Parameters<CloudDriveGateway["listFiles"]>[1] | undefined;
    const app = createApp(
      fakeGateway({
        listFiles: async (_subject, input) => {
          received = input;
          return { items: [makeFile({ name: "a.txt" })], nextCursor: "next-1" };
        },
      }),
    );

    const response = await request(app, "/cloud-drive/files?parentId=parent-1&cursor=cursor-1");

    expect(received).toEqual({ parentId: "parent-1", cursor: "cursor-1" });
    const body = (await readJson(response)) as {
      success: true;
      data: { items: Array<{ name: string }>; nextCursor: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.items[0]?.name).toBe("a.txt");
    expect(body.data.nextCursor).toBe("next-1");
  });

  // 下载透传 206、Content-Range 与字节流；白名单之外的响应头（set-cookie 等）必须被丢弃。
  test("下载透传 Range 与内容头且丢弃非白名单头", async () => {
    let range: string | undefined;
    const app = createApp(
      fakeGateway({
        getFile: async () => makeFile({ name: "报告 2026.txt" }),
        openContent: async (_subject, _fileId, input) => {
          range = input.range;
          return content("abc", "报告 2026.txt", 206, {
            "content-type": "text/plain",
            "content-range": "bytes 0-2/10",
            "content-length": "3",
            "content-disposition": "attachment",
            "set-cookie": "internal=1",
            "x-upstream-only": "secret",
          }).response;
        },
      }),
    );

    const response = await request(app, "/cloud-drive/files/file-1/content", {
      headers: { range: "bytes=0-2" },
    });

    expect(range).toBe("bytes=0-2");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-2/10");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="__ 2026.txt"; filename*=UTF-8''%E6%8A%A5%E5%91%8A%202026.txt`,
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-upstream-only")).toBeNull();
    expect(await response.text()).toBe("abc");
  });

  // 多段 Range 上游不支持：在 Fenix 侧就以 416 拒绝，避免被错误映射成 502。
  test("多段 Range 返回 416 且不调用远端", async () => {
    let called = false;
    const app = createApp(
      fakeGateway({
        openContent: async () => {
          called = true;
          return content("abc").response;
        },
      }),
    );

    const response = await request(app, "/cloud-drive/files/file-1/content", {
      headers: { range: "bytes=0-1,4-5" },
    });

    expect(response.status).toBe(416);
    expect(called).toBe(false);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "RANGE_NOT_SATISFIABLE", message: "只支持单个 bytes 字节区间" },
    });
  });

  // TUS 分片：客户端只发 offset 与原始字节，服务端转发并回写上游进度（响应头 + 信封）。
  test("分片上传转发 offset/长度并回写 Upload-Offset", async () => {
    let received: Parameters<CloudDriveGateway["patchUpload"]>[2] | undefined;
    const app = createApp(
      fakeGateway({
        patchUpload: async (_subject, _uploadId, input) => {
          received = input;
          return { uploadId: "upload-1", offset: 5, length: 10 };
        },
      }),
    );

    const response = await request(app, "/cloud-drive/uploads/upload-1", {
      method: "PATCH",
      headers: { "content-length": "3", "upload-offset": "2" },
      body: new Uint8Array([1, 2, 3]),
    });

    expect(response.status).toBe(200);
    expect(received?.offset).toBe(2);
    expect([...(received?.chunk ?? [])]).toEqual([1, 2, 3]);
    expect(response.headers.get("upload-offset")).toBe("5");
    expect(response.headers.get("upload-length")).toBe("10");
    expect(await readJson(response)).toEqual({
      success: true,
      data: { uploadId: "upload-1", offset: 5, length: 10 },
    });
  });

  // 缺 Content-Length 时必须 411：CloudDrive 拒绝 chunked，提前失败能给出可诊断的错误。
  test("分片上传缺 Content-Length 返回 411", async () => {
    const app = createApp(fakeGateway({}));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });

    const response = await request(app, "/cloud-drive/uploads/upload-1", {
      method: "PATCH",
      headers: { "upload-offset": "0" },
      body: stream,
      // Node 的 fetch 要求流式请求体声明 half duplex；Bun 接受该字段但不强制。
      duplex: "half",
    } as RequestInit);

    expect(response.status).toBe(411);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "CLOUD_DRIVE_LENGTH_REQUIRED", message: "分片请求必须携带 Content-Length" },
    });
  });

  // 上传会话已消费（上游 HEAD 404）必须是明确的业务 404，而不是上游故障。
  test("上传会话已消费返回 404 业务码", async () => {
    const app = createApp(
      fakeGateway({
        statUpload: async () => {
          throw new CloudDriveError("not-found", "NOT_FOUND", "文件不存在或无权访问");
        },
      }),
    );

    const response = await request(app, "/cloud-drive/uploads/upload-1");

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "CLOUD_DRIVE_UPLOAD_NOT_FOUND", message: "上传会话不存在或已结束" },
    });
  });

  // 上游输入错误与限流必须分别映射为 422 / 429，不能显示成 502 上游故障。
  test("上游输入错误与限流映射为 422 和 429", async () => {
    const invalidApp = createApp(
      fakeGateway({
        createDirectory: async () => {
          throw new CloudDriveError("unprocessable", "CLOUD_DRIVE_INVALID_INPUT", "请求参数不合法");
        },
      }),
    );
    const limitedApp = createApp(
      fakeGateway({
        getMe: async () => {
          throw new CloudDriveError("rate-limited", "CLOUD_DRIVE_RATE_LIMITED", "CloudDrive 请求过于频繁，请稍后重试");
        },
      }),
    );

    const invalid = await request(invalidApp, "/cloud-drive/directories", jsonInit("POST", { name: "docs" }));
    const limited = await request(limitedApp, "/cloud-drive/me");

    expect(invalid.status).toBe(422);
    expect(limited.status).toBe(429);
  });

  // 上游 NOT_FOUND 映射 404，响应体保持 /web 失败信封。
  test("上游不存在映射为 404 信封", async () => {
    const app = createApp(
      fakeGateway({
        getFile: async () => {
          throw new CloudDriveError("not-found", "NOT_FOUND", "文件不存在或无权访问");
        },
      }),
    );

    const response = await request(app, "/cloud-drive/files/file-1");

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "文件不存在或无权访问" },
    });
  });

  // 上游 401/403（master key 部署问题）必须 502，绝不能变成用户会话失效的 401。
  test("上游凭据错误映射为 502 而不是 401", async () => {
    const app = createApp(
      fakeGateway({
        getMe: async () => {
          throw new CloudDriveError("upstream", "CLOUD_DRIVE_UPSTREAM_ERROR", "CloudDrive 拒绝了服务端调用");
        },
      }),
    );

    const response = await request(app, "/cloud-drive/me");

    expect(response.status).toBe(502);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "CLOUD_DRIVE_UPSTREAM_ERROR", message: "CloudDrive 拒绝了服务端调用" },
    });
  });

  // 请求体校验失败统一成 400 信封，而不是 Elysia 默认的 422 结构。
  test("请求体不合法返回 400 信封", async () => {
    const app = createApp(fakeGateway({}));

    const response = await request(app, "/cloud-drive/directories", jsonInit("POST", {}));

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "请求参数不合法" },
    });
  });

  // 未配置 CloudDrive 时端点稳定返回 503，客户端可以直接展示「未启用」。
  test("未配置 CloudDrive 时返回 503", async () => {
    const facade = createCloudDriveFacade({
      resolveGateway: () => {
        throw new CloudDriveError("not-configured", "CLOUD_DRIVE_NOT_CONFIGURED", "CloudDrive 未配置");
      },
    });
    const app = createWebCloudDriveRoutes({
      authGuardPlugin: createStubSessionAuthGuardPlugin(AUTH),
      facade,
    });

    const response = await request(app, "/cloud-drive/files");

    expect(response.status).toBe(503);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "CLOUD_DRIVE_NOT_CONFIGURED", message: "CloudDrive 未配置" },
    });
  });

  // 建目录 / 改名 / 删除 / 恢复都返回统一的变更结果信封（便于前端读 operationId 排障）。
  test("变更类端点返回统一结果信封", async () => {
    const gateway = fakeGateway({
      getFile: async () => makeFile({ metadataRevision: 4 }),
      createDirectory: async () => makeMutation({ operationId: "op-mkdir" }),
      moveFile: async () => makeMutation({ operationId: "op-move" }),
      deleteFile: async () => makeMutation({ operationId: "op-delete" }),
      restoreTrash: async () => makeMutation({ operationId: "op-restore" }),
    });
    const app = createApp(gateway);

    const mkdir = (await readJson(
      await request(app, "/cloud-drive/directories", jsonInit("POST", { name: "docs" })),
    )) as { success: true; data: { operationId: string } };
    const move = (await readJson(
      await request(app, "/cloud-drive/files/file-1/location", jsonInit("PATCH", { name: "renamed.txt" })),
    )) as { success: true; data: { operationId: string } };
    const remove = (await readJson(await request(app, "/cloud-drive/files/file-1", { method: "DELETE" }))) as {
      success: true;
      data: { operationId: string };
    };
    const restore = (await readJson(
      await request(app, "/cloud-drive/trash/trash-1/restore", jsonInit("POST", { expectedMetadataRevision: 2 })),
    )) as { success: true; data: { operationId: string } };

    expect(mkdir.data.operationId).toBe("op-mkdir");
    expect(move.data.operationId).toBe("op-move");
    expect(remove.data.operationId).toBe("op-delete");
    expect(restore.data.operationId).toBe("op-restore");
  });
});
