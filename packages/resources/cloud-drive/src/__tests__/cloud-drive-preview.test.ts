import { describe, expect, test } from "bun:test";
import { readJson } from "@fenix/platform-sdk/testing";
import { upstreamError } from "../server/client/cloud-drive-error";
import type { CloudDriveGateway } from "../server/client/cloud-drive-gateway";
import { createCloudDriveFacade } from "../server/facades/cloud-drive-facade";
import { capMarkdownPage, MAX_MARKDOWN_PAGE_BYTES } from "../server/facades/cloud-drive-preview";
import type { SessionAuthContext } from "../server/routes/dependencies";
import { createWebCloudDriveRoutes } from "../server/routes/web/cloud-drive";
import { createStubSessionAuthGuardPlugin, fakeGateway, makeFile } from "./cloud-drive-fixtures";

const AUTH: SessionAuthContext = { userId: "user-a", organizationId: "org-1" };
const AUTH_B: SessionAuthContext = { userId: "user-b", organizationId: "org-1" };

function createApp(gateway: CloudDriveGateway, authContext: SessionAuthContext | null = AUTH) {
  const facade = createCloudDriveFacade({
    resolveGateway: () => gateway,
    newIdempotencyKey: () => "idempotency-fixed",
  });
  return createWebCloudDriveRoutes({
    authGuardPlugin: createStubSessionAuthGuardPlugin(authContext),
    facade,
  });
}

function request(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  return app.handle(new Request(`http://localhost${path}`, init));
}

function conversion(status: string | null, errorCode: string | null = null) {
  return { status, errorCode, completeness: null };
}

describe("CloudDrive 预览路由", () => {
  // markdown 分页的游标必须透传给上游；响应同时带出版本与转换状态，前端据此决定是否继续。
  test("markdown 返回信封、透传 cursor 与转换状态", async () => {
    let receivedCursor: string | undefined;
    let receivedSubject = "";
    const app = createApp(
      fakeGateway({
        getFile: async (subject) => {
          receivedSubject = subject;
          return makeFile({ name: "notes.docx", conversion: conversion("ready") });
        },
        getMarkdown: async (_subject, _fileId, input) => {
          receivedCursor = input.cursor;
          return { content: "# 标题", nextCursor: "cursor-2", versionId: "version-1" };
        },
      }),
    );

    const response = await request(app, "/cloud-drive/files/file-1/markdown?cursor=cursor-1");

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      success: true,
      data: {
        content: "# 标题",
        nextCursor: "cursor-2",
        versionId: "version-1",
        conversionStatus: "ready",
        truncated: false,
      },
    });
    expect(receivedCursor).toBe("cursor-1");
    expect(receivedSubject).toBe("user-a");
  });

  // 上游对未转换产物返回 404，Fenix 必须给出可识别的「尚未就绪」而不是泛化的文件不存在。
  test("未转换的 markdown 映射为 404 CLOUD_DRIVE_PREVIEW_NOT_READY", async () => {
    const app = createApp(
      fakeGateway({
        getFile: async () => makeFile({ conversion: conversion("processing") }),
        getMarkdown: async () => {
          throw upstreamError(404, { error: { code: "NOT_FOUND", message: "no published artifact" } });
        },
      }),
    );

    const response = await request(app, "/cloud-drive/files/file-1/markdown");

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "CLOUD_DRIVE_PREVIEW_NOT_READY", message: "文件尚未转换完成" },
    });
  });

  // 转换失败（如缺 OCR 的图片）不是暂时状态：返回 422 让前端展示原因与「重新转换」，而不是继续轮询。
  test("转换失败的 markdown 映射为 422 CLOUD_DRIVE_PREVIEW_FAILED", async () => {
    const app = createApp(
      fakeGateway({
        getFile: async () => makeFile({ conversion: conversion("failed", "malformed") }),
        getMarkdown: async () => {
          throw upstreamError(404, { error: { code: "NOT_FOUND", message: "no published artifact" } });
        },
      }),
    );

    const response = await request(app, "/cloud-drive/files/file-1/markdown");

    expect(response.status).toBe(422);
    expect(await readJson(response)).toMatchObject({
      success: false,
      error: { code: "CLOUD_DRIVE_PREVIEW_FAILED" },
    });
  });

  // 上游超限（413）必须保持 413 语义，前端才能显示「文件超出上限」而不是上游故障。
  test("markdown 上游 413 映射为 413 CLOUD_DRIVE_PAYLOAD_TOO_LARGE", async () => {
    const app = createApp(
      fakeGateway({
        getFile: async () => makeFile({ conversion: conversion("ready") }),
        getMarkdown: async () => {
          throw upstreamError(413, { error: { code: "UPLOAD_TOO_LARGE" } });
        },
      }),
    );

    const response = await request(app, "/cloud-drive/files/file-1/markdown");

    expect(response.status).toBe(413);
    expect(await readJson(response)).toMatchObject({
      success: false,
      error: { code: "CLOUD_DRIVE_PAYLOAD_TOO_LARGE" },
    });
  });

  // 单次响应有界：上游若改变分页契约（一页远超 64KiB），截断并标记，游标仍保留以便继续。
  test("超长 markdown 页被截断并保留上游游标", async () => {
    const app = createApp(
      fakeGateway({
        getFile: async () => makeFile({ conversion: conversion("ready") }),
        getMarkdown: async () => ({
          content: "a".repeat(MAX_MARKDOWN_PAGE_BYTES + 1024),
          nextCursor: "cursor-next",
          versionId: "version-1",
        }),
      }),
    );

    const response = await request(app, "/cloud-drive/files/file-1/markdown");
    const body = (await readJson(response)) as {
      data: { content: string; nextCursor: string | null; truncated: boolean };
    };

    expect(response.status).toBe(200);
    expect(body.data.truncated).toBe(true);
    expect(new TextEncoder().encode(body.data.content).byteLength).toBeLessThanOrEqual(MAX_MARKDOWN_PAGE_BYTES);
    expect(body.data.nextCursor).toBe("cursor-next");
  });

  // 栅格清单只下发页号与版本，不下发上游页图 URL（URL 属于 CloudDrive 内部路径）。
  test("栅格清单返回连续页号与版本；上游 503 保持 503", async () => {
    const okApp = createApp(
      fakeGateway({
        getFile: async () => makeFile({ conversion: conversion("ready") }),
        getPreview: async () => ({ versionId: "version-9", pageCount: 2, pages: [1, 2] }),
      }),
    );
    const ok = await request(okApp, "/cloud-drive/files/file-1/preview");
    expect(ok.status).toBe(200);
    expect(await readJson(ok)).toEqual({
      success: true,
      data: { versionId: "version-9", pageCount: 2, pages: [1, 2], conversionStatus: "ready" },
    });

    const failingApp = createApp(
      fakeGateway({
        getFile: async () => makeFile({ conversion: null }),
        getPreview: async () => {
          throw upstreamError(503, { error: { code: "DEPENDENCY_UNAVAILABLE" } });
        },
      }),
    );
    const failing = await request(failingApp, "/cloud-drive/files/file-1/preview");
    expect(failing.status).toBe(503);
    expect(await readJson(failing)).toMatchObject({ success: false, error: { code: "CLOUD_DRIVE_UNAVAILABLE" } });
  });

  // 页图：版本号必须原样到达上游，二进制头透传，并允许按版本缓存。
  test("页图透传 Content-Type / Content-Length 并强制带 versionId", async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    let received: { page: number; versionId: string } | undefined;
    const app = createApp(
      fakeGateway({
        getFile: async () => makeFile({ currentVersionId: "version-current" }),
        openPreviewPage: async (_subject, _fileId, input) => {
          received = input;
          return new Response(png, {
            status: 200,
            headers: { "content-type": "image/png", "content-length": String(png.byteLength), etag: '"v1"' },
          });
        },
      }),
    );

    const response = await request(app, "/cloud-drive/files/file-1/preview/pages/2?versionId=version-explicit");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(String(png.byteLength));
    expect(response.headers.get("etag")).toBe('"v1"');
    expect(response.headers.get("cache-control")).toBe("private, max-age=300, immutable");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    expect(received).toEqual({ page: 2, versionId: "version-explicit" });
  });

  // 省略版本时用元数据当前版本补齐；此时 URL 不含版本，禁止缓存，避免换版本后命中旧页图。
  test("省略 versionId 时使用当前版本且禁止缓存", async () => {
    let received: { page: number; versionId: string } | undefined;
    const app = createApp(
      fakeGateway({
        getFile: async () => makeFile({ currentVersionId: "version-current" }),
        openPreviewPage: async (_subject, _fileId, input) => {
          received = input;
          return new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } });
        },
      }),
    );

    const response = await request(app, "/cloud-drive/files/file-1/preview/pages/1");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(received).toEqual({ page: 1, versionId: "version-current" });
  });

  // 页号必须是正整数：0 / 非数字都在 Fenix 侧 400，不把上游的 404 混成「未就绪」。
  test("非法页号返回 400", async () => {
    let called = false;
    const app = createApp(
      fakeGateway({
        getFile: async () => makeFile(),
        openPreviewPage: async () => {
          called = true;
          return new Response(new Uint8Array([1]));
        },
      }),
    );

    for (const path of [
      "/cloud-drive/files/file-1/preview/pages/0?versionId=version-1",
      "/cloud-drive/files/file-1/preview/pages/abc?versionId=version-1",
    ]) {
      const response = await request(app, path);
      expect([path, response.status]).toEqual([path, 400]);
    }
    expect(called).toBe(false);
  });

  // 页图 404 可能是页号越界或版本不存在：给出独立的 code，前端提示换页/重试而不是「文件不存在」。
  test("页图 404 映射为 CLOUD_DRIVE_PREVIEW_PAGE_NOT_FOUND", async () => {
    const app = createApp(
      fakeGateway({
        getFile: async () => makeFile({ currentVersionId: "version-1" }),
        openPreviewPage: async () => {
          throw upstreamError(404, { error: { code: "NOT_FOUND" } });
        },
      }),
    );

    const response = await request(app, "/cloud-drive/files/file-1/preview/pages/9?versionId=version-1");

    expect(response.status).toBe(404);
    expect(await readJson(response)).toMatchObject({
      success: false,
      error: { code: "CLOUD_DRIVE_PREVIEW_PAGE_NOT_FOUND" },
    });
  });

  // 重新转换只对未完成/失败的文件有意义：服务端生成幂等键，正在转换或已就绪一律 409。
  test("重新转换在失败状态下排队并生成幂等键", async () => {
    let received: { idempotencyKey: string } | undefined;
    const app = createApp(
      fakeGateway({
        getFile: async () => makeFile({ conversion: conversion("failed", "malformed") }),
        requestConversion: async (_subject, _fileId, input) => {
          received = input;
          return { jobId: "job-1", state: "queued", sourceVersionId: "version-1" };
        },
      }),
    );

    const response = await request(app, "/cloud-drive/files/file-1/conversions", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      success: true,
      data: { jobId: "job-1", state: "queued", sourceVersionId: "version-1" },
    });
    expect(received?.idempotencyKey).toBe("idempotency-fixed");
  });

  test("转换进行中或已就绪时拒绝重新转换", async () => {
    for (const [status, code] of [
      ["processing", "CLOUD_DRIVE_CONVERSION_IN_PROGRESS"],
      ["ready", "CLOUD_DRIVE_CONVERSION_NOT_NEEDED"],
    ] as const) {
      const app = createApp(
        fakeGateway({
          getFile: async () => makeFile({ conversion: conversion(status) }),
          requestConversion: async () => {
            throw new Error("不应调用上游转换");
          },
        }),
      );
      const response = await request(app, "/cloud-drive/files/file-1/conversions", { method: "POST" });
      expect([status, response.status]).toEqual([status, 409]);
      expect(await readJson(response)).toMatchObject({ success: false, error: { code } });
    }
  });

  // 目录没有预览产物：提前 400，而不是让上游返回无法解释的 404。
  test("目录请求预览返回 400 CLOUD_DRIVE_NOT_A_FILE", async () => {
    const app = createApp(
      fakeGateway({ getFile: async () => makeFile({ kind: "directory", currentVersionId: null }) }),
    );

    const markdown = await request(app, "/cloud-drive/files/file-1/markdown");
    const preview = await request(app, "/cloud-drive/files/file-1/preview");

    for (const response of [markdown, preview]) {
      expect(response.status).toBe(400);
      expect(await readJson(response)).toMatchObject({ success: false, error: { code: "CLOUD_DRIVE_NOT_A_FILE" } });
    }
  });

  // 两个会话各自只看到自己的主体：预览链路不得出现「查询串指定 subject」的旁路。
  test("不同会话的预览请求使用各自的主体", async () => {
    const subjects: string[] = [];
    const gateway = fakeGateway({
      getFile: async (subject) => {
        subjects.push(subject);
        return makeFile({ conversion: conversion("ready") });
      },
      getMarkdown: async () => ({ content: "ok", nextCursor: null, versionId: "version-1" }),
    });

    await request(createApp(gateway, AUTH), "/cloud-drive/files/file-1/markdown?userId=user-b");
    await request(createApp(gateway, AUTH_B), "/cloud-drive/files/file-1/markdown");

    expect(subjects).toEqual(["user-a", "user-b"]);
  });
});

describe("markdown 页截断", () => {
  // 未超限时原样返回；截断只应发生在防御性上限被触发时。
  test("未超限时不截断", () => {
    expect(capMarkdownPage("hello")).toEqual({ content: "hello", truncated: false });
  });

  // 多字节字符不能按字节直接切：结果必须是合法 UTF-8 且不超过上限。
  test("按 UTF-8 边界截断且不产生孤立代理项", () => {
    const content = "云盘预览😀".repeat(10_000);
    const capped = capMarkdownPage(content, 1024);

    expect(capped.truncated).toBe(true);
    expect(new TextEncoder().encode(capped.content).byteLength).toBeLessThanOrEqual(1024);
    expect(capped.content).toBe([...capped.content].join(""));
    expect(content.startsWith(capped.content)).toBe(true);
  });
});
