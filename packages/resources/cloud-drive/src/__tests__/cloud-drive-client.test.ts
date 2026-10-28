import { describe, expect, test } from "bun:test";
import {
  CloudDriveClient,
  type CloudDriveClientConfig,
  type CloudDriveDiagnostic,
  resolveCloudDriveClientConfig,
} from "../server/client/cloud-drive-client";
import { CloudDriveError } from "../server/client/cloud-drive-error";
import { jsonResponse } from "./cloud-drive-fixtures";

const CONFIG: CloudDriveClientConfig = {
  baseUrl: "http://clouddrive.test/",
  masterKey: "master-key-should-never-leak",
  keyId: "fenix-test",
  timeoutMs: 1_000,
};

function wireFile(overrides: Record<string, unknown> = {}) {
  return {
    id: "file-1",
    parent_id: null,
    name: "report.txt",
    path: "/report.txt",
    kind: "file",
    lifecycle: "active",
    metadata_revision: 2,
    size_bytes: 3,
    content_type: "text/plain",
    current_version_id: "version-1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    conversion: null,
    ...overrides,
  };
}

function clientWith(fetchImpl: ConstructorParameters<typeof CloudDriveClient>[0]["fetchImpl"], config = CONFIG) {
  return new CloudDriveClient({ config, fetchImpl });
}

describe("CloudDrive 出站 client", () => {
  // 认证头只能来自注入配置：master key、主体断言与可选 key id 必须逐请求发送，且基址尾部斜杠被归一。
  test("请求携带 master key、X-On-Behalf-Of 与选定的查询参数", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = clientWith(async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return jsonResponse({ items: [], next_cursor: null });
    });

    const page = await client.listFiles("user-a", { parentId: "parent-1", cursor: "cursor-1" });

    expect(page).toEqual({ items: [], nextCursor: null });
    const [request] = requests;
    const headers = new Headers(request?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${CONFIG.masterKey}`);
    expect(headers.get("x-on-behalf-of")).toBe("user-a");
    expect(headers.get("x-key-id")).toBe("fenix-test");
    expect(request?.url).toBe("http://clouddrive.test/v1/files?parent_id=parent-1&cursor=cursor-1");
  });

  // 不同会话用户必须产生不同的主体断言：隔离靠这一行 header，不能靠调用方自觉。
  test("不同 userId 的请求使用各自的 X-On-Behalf-Of", async () => {
    const subjects: string[] = [];
    const client = clientWith(async (_input, init) => {
      const subject = new Headers(init?.headers).get("x-on-behalf-of") ?? "";
      subjects.push(subject);
      return jsonResponse(wireFile({ name: `${subject}.txt` }));
    });

    const first = await client.getFile("user-a", "file-1");
    const second = await client.getFile("user-b", "file-1");

    expect(subjects).toEqual(["user-a", "user-b"]);
    expect(first.name).toBe("user-a.txt");
    expect(second.name).toBe("user-b.txt");
  });

  // 上游 401/403 是 master key / 网段 / scope 的部署问题：必须归为 502 类且不把上游细节带出去。
  test("上游 401/403 映射为通用上游错误且不泄露密钥或上游文案", async () => {
    for (const status of [401, 403]) {
      const client = clientWith(async () =>
        jsonResponse({ error: { code: "UNAUTHENTICATED", message: "invalid master key" } }, status),
      );
      const error = (await client.getMe("user-a").catch((caught) => caught)) as CloudDriveError;

      expect(error).toBeInstanceOf(CloudDriveError);
      expect(error.kind).toBe("upstream");
      expect(error.code).toBe("CLOUD_DRIVE_UPSTREAM_ERROR");
      expect(error.message).toBe("CloudDrive 拒绝了服务端调用");
      expect(error.message).not.toContain("master");
      expect(error.message).not.toContain("invalid master key");
      expect(error.upstreamStatus).toBe(status);
    }
  });

  // 业务 code 优先于 HTTP 状态：CloudDrive 用 422 同时承载配额与参数错误，只按状态会丢失语义。
  test("按上游业务 code 分类冲突、配额、依赖不可用与不存在", async () => {
    const cases: Array<[number, string, string]> = [
      [404, "NOT_FOUND", "not-found"],
      [409, "PATH_CONFLICT", "conflict"],
      [409, "VERSION_CONFLICT", "conflict"],
      [409, "IDEMPOTENCY_CONFLICT", "conflict"],
      [409, "OPERATION_PENDING", "conflict"],
      [422, "QUOTA_EXCEEDED", "payload-too-large"],
      [413, "UPLOAD_TOO_LARGE", "payload-too-large"],
      [503, "DEPENDENCY_UNAVAILABLE", "unavailable"],
      [503, "SPACE_PROVISIONER_UNAVAILABLE", "unavailable"],
      [422, "INVALID_ARGUMENT", "unprocessable"],
      [422, "INVALID_PATH", "unprocessable"],
      [422, "SOMETHING_ELSE", "unprocessable"],
      [429, "RATE_LIMITED", "rate-limited"],
      [500, "INTERNAL_ERROR", "upstream"],
    ];

    for (const [status, code, kind] of cases) {
      const client = clientWith(async () => jsonResponse({ error: { code, message: "upstream detail" } }, status));
      const error = (await client.getFile("user-a", "file-1").catch((caught) => caught)) as CloudDriveError;
      expect([status, code, error.kind]).toEqual([status, code, kind]);
      expect(error.message).not.toContain("upstream detail");
    }
  });

  // 超时必须由 AbortController 主动中止，并归类为可退避重试的 unavailable/timeout。
  test("请求超时归为 CLOUD_DRIVE_TIMEOUT", async () => {
    const client = clientWith(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout")));
        }),
      { ...CONFIG, timeoutMs: 10 },
    );

    const error = (await client.getMe("user-a").catch((caught) => caught)) as CloudDriveError;

    expect(error).toBeInstanceOf(CloudDriveError);
    expect(error.kind).toBe("unavailable");
    expect(error.code).toBe("CLOUD_DRIVE_TIMEOUT");
  });

  // 成功响应不是 JSON 或字段漂移时必须 502，而不是把 undefined 透给前端。
  test("上游成功响应形状漂移归为无法识别的响应", async () => {
    const client = clientWith(async () => new Response("not-json", { status: 200 }));

    const error = (await client.getMe("user-a").catch((caught) => caught)) as CloudDriveError;

    expect(error.kind).toBe("upstream");
    expect(error.code).toBe("CLOUD_DRIVE_UPSTREAM_ERROR");
    expect(error.message).toContain("无法识别");
  });

  // 主体标识必须先过 CloudDrive 的合法形状校验：否则 400 会在上游变成 502。
  test("非法 subject 在发出请求前失败", async () => {
    let called = false;
    const client = clientWith(async () => {
      called = true;
      return jsonResponse(wireFile());
    });

    const error = (await client.getFile("bad subject!", "file-1").catch((caught) => caught)) as CloudDriveError;

    expect(called).toBe(false);
    expect(error.kind).toBe("invalid");
    expect(error.code).toBe("CLOUD_DRIVE_SUBJECT_INVALID");
  });

  // TUS 分片必须带齐协议头，Content-Length 由实际字节数覆盖，返回的 offset/length 以响应头为准。
  test("TUS PATCH 发送 offset、长度与固定内容类型并回读响应头", async () => {
    let captured: { init: RequestInit; body: Uint8Array | null } | undefined;
    const client = clientWith(async (_input, init) => {
      captured = { init: init ?? {}, body: init?.body instanceof Uint8Array ? init.body : null };
      return new Response(null, {
        status: 204,
        headers: { "upload-offset": "5", "upload-length": "10", "tus-resumable": "1.0.0" },
      });
    });

    const status = await client.patchUpload("user-a", "upload-1", {
      offset: 2,
      chunk: new Uint8Array([1, 2, 3]),
    });

    expect(status).toEqual({ uploadId: "upload-1", offset: 5, length: 10 });
    const headers = new Headers(captured?.init.headers);
    expect(captured?.init.method).toBe("PATCH");
    expect(headers.get("content-type")).toBe("application/offset+octet-stream");
    expect(headers.get("upload-offset")).toBe("2");
    expect(headers.get("content-length")).toBe("3");
    expect(headers.get("tus-resumable")).toBe("1.0.0");
    expect([...(captured?.body ?? [])]).toEqual([1, 2, 3]);
  });

  // 进度只在响应头里；缺失或非数值说明上游协议漂移，不能把 NaN 当成 offset 交给前端。
  test("TUS HEAD 缺少进度头时归为无法识别的响应", async () => {
    const client = clientWith(async () => new Response(null, { status: 200 }));

    const error = (await client.statUpload("user-a", "upload-1").catch((caught) => caught)) as CloudDriveError;

    expect(error.kind).toBe("upstream");
    expect(error.code).toBe("CLOUD_DRIVE_UPSTREAM_ERROR");
  });

  // 内容下载只把白名单头交给上层；Range 必须原样转发，状态码（206）保持上游语义。
  test("内容下载转发 Range 并返回未消费的字节流", async () => {
    const captured: { range: string | null } = { range: null };
    const client = clientWith(async (_input, init) => {
      captured.range = new Headers(init?.headers).get("range");
      return new Response("abc", {
        status: 206,
        headers: { "content-range": "bytes 0-2/10", "content-type": "text/plain", "content-length": "3" },
      });
    });

    const content = await client.openContent("user-a", "file-1", { range: "bytes=0-2" });

    expect(captured.range).toBe("bytes=0-2");
    expect(content.status).toBe(206);
    expect(content.headers.get("content-range")).toBe("bytes 0-2/10");
    expect(await new Response(content.body).text()).toBe("abc");
  });

  // 诊断事件只保留调用元数据：不能出现 headers/body/master key，且失败必须带上游状态与业务 code。
  test("诊断事件不含认证材料且失败时带状态与 code", async () => {
    const events: CloudDriveDiagnostic[] = [];
    const client = new CloudDriveClient({
      config: CONFIG,
      fetchImpl: async () => jsonResponse({ error: { code: "PATH_CONFLICT", message: "exists" } }, 409),
      onDiagnostic: (event) => events.push(event),
    });

    await client.createDirectory("user-a", { name: "docs", idempotencyKey: "key-1" }).catch(() => undefined);

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.operation).toBe("createDirectory");
    expect(event?.subject).toBe("user-a");
    expect(event?.status).toBe(409);
    expect(event?.code).toBe("CLOUD_DRIVE_CONFLICT");
    expect(event?.outcome).toBe("error");
    expect(Object.keys(event ?? {}).sort()).toEqual(
      ["code", "durationMs", "operation", "outcome", "status", "subject"].sort(),
    );
  });

  // 缺基址或缺 master key 时必须在发请求前失败，让路由稳定返回 503 而不是 undefined/v1/me。
  test("模块配置缺基址或密钥时解析失败为未配置", () => {
    expect(() => resolveCloudDriveClientConfig({ timeoutMs: 1_000 })).toThrow(CloudDriveError);
    expect(() =>
      resolveCloudDriveClientConfig({ baseUrl: "http://clouddrive.test", masterKey: "   ", timeoutMs: 1_000 }),
    ).toThrow(CloudDriveError);
    expect(
      resolveCloudDriveClientConfig({
        baseUrl: "http://clouddrive.test/",
        masterKey: "secret",
        keyId: "",
        timeoutMs: 1_000,
      }),
    ).toEqual({ baseUrl: "http://clouddrive.test/", masterKey: "secret", keyId: undefined, timeoutMs: 1_000 });
  });

  // 恢复的 parentId 区分「根目录」与「原目录」：null 传 parent_id=null，省略则不传。
  test("回收站恢复区分 parentId 的 null 与省略", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const client = clientWith(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({
        operation_id: "operation-1",
        file_id: "file-1",
        state: "committed",
        error_code: null,
        file: null,
      });
    });

    await client.restoreTrash("user-a", "trash-1", {
      expectedMetadataRevision: 2,
      parentId: null,
      idempotencyKey: "key-1",
    });
    await client.restoreTrash("user-a", "trash-2", {
      expectedMetadataRevision: 3,
      idempotencyKey: "key-2",
    });

    expect(bodies[0]).toMatchObject({ parent_id: null, expected_metadata_revision: 2 });
    expect(bodies[1]).not.toHaveProperty("parent_id");
  });

  // 覆盖写必须把当前版本与修订号原样送到上游；漏传会被 CloudDrive 判成 VERSION_CONFLICT。
  test("覆盖写上传发送 file_id、expected_version_id 与 expected_metadata_revision", async () => {
    let body: Record<string, unknown> | undefined;
    const client = clientWith(async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        id: "upload-1",
        file_id: "file-1",
        operation_id: "operation-1",
        status: "uploading",
        upload_url: "http://internal/v1/tus/upload-1",
      });
    });

    const upload = await client.beginUpload("user-a", {
      fileId: "file-1",
      parentId: null,
      name: "report.txt",
      sizeBytes: 10,
      expectedVersionId: "version-1",
      expectedMetadataRevision: 4,
      idempotencyKey: "key-1",
    });

    expect(upload).toEqual({
      uploadId: "upload-1",
      fileId: "file-1",
      operationId: "operation-1",
      status: "uploading",
      expiresAt: null,
    });
    expect(upload).not.toHaveProperty("uploadUrl");
    expect(body).toMatchObject({
      file_id: "file-1",
      name: "report.txt",
      size_bytes: 10,
      expected_version_id: "version-1",
      expected_metadata_revision: 4,
      idempotency_key: "key-1",
    });
    expect(body).not.toHaveProperty("parent_id");
  });
});
