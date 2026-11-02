/**
 * CloudDrive 本地联调 / 验收脚本（**默认不运行**）。
 *
 * 运行方式（在 worktree 根）：
 *
 * ```bash
 * CLOUD_DRIVE_SMOKE=1 \
 * FENIX_BASE_URL=http://127.0.0.1:3101 \
 * bun run scripts/cloud-drive-local-smoke.ts
 * ```
 *
 * 前置：Fenix 服务已按 `docs/operations/cloud-drive-local-smoke.md` 启动，并配置了
 * `CLOUDDRIVE_BASE_URL` / `CLOUDDRIVE_MASTER_KEY` / `CLOUDDRIVE_KEY_ID`。
 *
 * 未提供会话时脚本会经 `/api/auth/sign-up/email` 创建两个一次性用户（随机邮箱与密码，密码不打印）。
 * 若目标库是共享库，设置 `CLOUD_DRIVE_SMOKE_CLEANUP=1` 且提供 `DATABASE_URL`，脚本结束时删除这两个用户
 * 及其个人组织；否则脚本只打印邮箱，建议改用一次性数据库（见运维文档）。
 *
 * 脚本只访问 Fenix `/web/*`，不直接访问 CloudDrive，也不读取 master key。
 */

interface Session {
  readonly label: string;
  readonly email: string;
  readonly userId: string;
  readonly cookie: string;
}

interface HttpResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}

interface Row {
  readonly step: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly detail: string;
}

const ENABLED = process.env.CLOUD_DRIVE_SMOKE === "1" || process.argv.includes("--cloud-drive-smoke");
if (!ENABLED) {
  console.log("跳过 cloud-drive 本地联调（设置 CLOUD_DRIVE_SMOKE=1 或传 --cloud-drive-smoke 运行）");
  process.exit(0);
}

const BASE_URL = (process.env.FENIX_BASE_URL ?? "http://127.0.0.1:3101").replace(/\/+$/, "");
const DATABASE_URL = process.env.DATABASE_URL;
const rows: Row[] = [];
const createdUsers: Session[] = [];
const failures: string[] = [];

function record(
  step: string,
  method: string,
  path: string,
  result: HttpResult,
  detail: string,
  expected: readonly number[] = [200],
): void {
  rows.push({ step, method, path, status: result.status, detail });
  const marker = expected.includes(result.status) ? "ok" : "fail";
  console.log(`[${marker}] ${step} | ${method} ${path} -> ${result.status} | ${detail}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function bodyOf<T>(result: HttpResult): T {
  return result.body as T;
}

function errorCode(result: HttpResult): string {
  const body = result.body as { error?: { code?: string } } | null;
  return body?.error?.code ?? "";
}

/** 一次 HTTP 调用；`session` 为空时不带 cookie（用于注册）。 */
async function http(
  session: Session | null,
  method: string,
  path: string,
  options: { json?: unknown; body?: Uint8Array | string; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const headers = new Headers(options.headers);
  if (session) headers.set("cookie", session.cookie);
  headers.set("origin", BASE_URL);
  if (options.json !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: options.body ?? (options.json !== undefined ? JSON.stringify(options.json) : undefined),
    redirect: "manual",
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body, headers: response.headers };
}

function cookieJar(response: Response): string {
  const values = response.headers.getSetCookie?.() ?? [];
  const pairs = values.map((value) => value.split(";")[0] ?? "").filter((pair) => pair.includes("="));
  return pairs.join("; ");
}

/** 创建一个一次性用户并返回其会话 cookie。 */
async function signUp(label: string): Promise<Session> {
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const email = `clouddrive-smoke-${label}-${suffix}@example.invalid`;
  const password = `${crypto.randomUUID()}Aa1!`;
  const response = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE_URL },
    body: JSON.stringify({ name: `CloudDrive Smoke ${label}`, email, password }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`用户 ${label} 注册失败：HTTP ${response.status} ${text.slice(0, 200)}`);
  const payload = JSON.parse(text) as { user?: { id?: string } };
  const userId = payload.user?.id;
  assert(typeof userId === "string" && userId.length > 0, `用户 ${label} 注册响应缺少 user.id`);
  const cookie = cookieJar(response);
  assert(cookie.length > 0, `用户 ${label} 注册响应没有下发会话 cookie`);
  const session: Session = { label, email, userId, cookie };
  createdUsers.push(session);
  return session;
}

function sessionFromEnv(label: "A" | "B"): Session | null {
  const cookie = label === "A" ? process.env.CLOUD_DRIVE_SMOKE_COOKIE_A : process.env.CLOUD_DRIVE_SMOKE_COOKIE_B;
  if (!cookie) return null;
  return { label, email: `(env CLOUD_DRIVE_SMOKE_COOKIE_${label})`, userId: `(env ${label})`, cookie };
}

async function main(): Promise<void> {
  const sessionA = sessionFromEnv("A") ?? (await signUp("A"));
  const sessionB = sessionFromEnv("B") ?? (await signUp("B"));
  console.log(`用户 A：${sessionA.email}（${sessionA.userId}）`);
  console.log(`用户 B：${sessionB.email}（${sessionB.userId}）`);

  // ── A：主体、配额、根列表 ───────────────────────────────
  const me = await http(sessionA, "GET", "/web/cloud-drive/me");
  record(
    "A 主体与配额",
    "GET",
    "/web/cloud-drive/me",
    me,
    `subject=${bodyOf<{ data?: { subject?: string } }>(me).data?.subject ?? "?"}`,
  );
  assert(me.status === 200, `A /me 失败：${me.status}`);

  const rootList = await http(sessionA, "GET", "/web/cloud-drive/files");
  const rootItems = bodyOf<{ data?: { items?: unknown[] } }>(rootList).data?.items ?? [];
  record("A 根目录列表", "GET", "/web/cloud-drive/files", rootList, `items=${rootItems.length}`);
  assert(rootList.status === 200, `A 列表失败：${rootList.status}`);

  // ── A：建目录 + 冲突 + 用户输入错误映射 ──────────────────
  const dirName = `smoke-dir-${Date.now()}`;
  const mkdir = await http(sessionA, "POST", "/web/cloud-drive/directories", { json: { name: dirName } });
  const dirId = bodyOf<{ data?: { fileId?: string } }>(mkdir).data?.fileId ?? "";
  record("A 建目录", "POST", "/web/cloud-drive/directories", mkdir, `name=${dirName} fileId=${dirId}`);
  assert(mkdir.status === 200 && dirId, `A 建目录失败：${mkdir.status} ${JSON.stringify(mkdir.body)}`);

  const conflict = await http(sessionA, "POST", "/web/cloud-drive/directories", { json: { name: dirName } });
  record("A 同名目录冲突", "POST", "/web/cloud-drive/directories", conflict, `code=${errorCode(conflict)}`, [409]);
  assert(conflict.status === 409, `同名目录应为 409，实际 ${conflict.status}`);

  const reserved = await http(sessionA, "POST", "/web/cloud-drive/directories", {
    json: { name: ".clouddrive-trash" },
  });
  record(
    "A 保留字目录（上游 INVALID_PATH）",
    "POST",
    "/web/cloud-drive/directories",
    reserved,
    `code=${errorCode(reserved)}`,
    [422],
  );
  assert(reserved.status === 422, `保留字目录应为 422，实际 ${reserved.status}`);

  // ── A：TUS 上传（两片，中途查 offset） ───────────────────
  const content = "hello clouddrive\n";
  const bytes = new TextEncoder().encode(content);
  const uploadName = `hello-${Date.now()}.txt`;
  const begin = await http(sessionA, "POST", "/web/cloud-drive/uploads", {
    json: { parentId: dirId, name: uploadName, sizeBytes: bytes.byteLength, contentType: "text/plain" },
  });
  const uploadId = bodyOf<{ data?: { uploadId?: string; fileId?: string } }>(begin).data?.uploadId ?? "";
  const fileId = bodyOf<{ data?: { fileId?: string } }>(begin).data?.fileId ?? "";
  record("A 创建上传会话", "POST", "/web/cloud-drive/uploads", begin, `uploadId=${uploadId} fileId=${fileId}`);
  assert(begin.status === 200 && uploadId && fileId, `创建上传失败：${begin.status} ${JSON.stringify(begin.body)}`);

  const firstChunk = bytes.slice(0, 8);
  const patchOne = await http(sessionA, "PATCH", `/web/cloud-drive/uploads/${uploadId}`, {
    headers: { "content-length": String(firstChunk.byteLength), "upload-offset": "0" },
    body: firstChunk,
  });
  record(
    "A 上传分片 #1",
    "PATCH",
    `/web/cloud-drive/uploads/${uploadId}`,
    patchOne,
    `offset=${bodyOf<{ data?: { offset?: number } }>(patchOne).data?.offset ?? "?"}`,
  );
  assert(patchOne.status === 200, `分片 #1 失败：${patchOne.status} ${JSON.stringify(patchOne.body)}`);

  const midStatus = await http(sessionA, "GET", `/web/cloud-drive/uploads/${uploadId}`);
  const midOffset = bodyOf<{ data?: { offset?: number; length?: number } }>(midStatus).data?.offset ?? -1;
  record(
    "A 查询上传进度",
    "GET",
    `/web/cloud-drive/uploads/${uploadId}`,
    midStatus,
    `offset=${midOffset} length=${bodyOf<{ data?: { length?: number } }>(midStatus).data?.length ?? "?"}`,
  );
  assert(midStatus.status === 200, `查询上传进度失败：${midStatus.status}`);

  const secondChunk = bytes.slice(8);
  const patchTwo = await http(sessionA, "PATCH", `/web/cloud-drive/uploads/${uploadId}`, {
    headers: { "content-length": String(secondChunk.byteLength), "upload-offset": String(firstChunk.byteLength) },
    body: secondChunk,
  });
  record(
    "A 上传分片 #2",
    "PATCH",
    `/web/cloud-drive/uploads/${uploadId}`,
    patchTwo,
    `offset=${bodyOf<{ data?: { offset?: number } }>(patchTwo).data?.offset ?? "?"}`,
  );
  assert(patchTwo.status === 200, `分片 #2 失败：${patchTwo.status} ${JSON.stringify(patchTwo.body)}`);

  const finalize = await http(sessionA, "POST", `/web/cloud-drive/uploads/${uploadId}/finalize`);
  const versionId = bodyOf<{ data?: { versionId?: string; status?: string } }>(finalize).data?.versionId ?? "";
  record(
    "A 提交上传",
    "POST",
    `/web/cloud-drive/uploads/${uploadId}/finalize`,
    finalize,
    `versionId=${versionId} status=${bodyOf<{ data?: { status?: string } }>(finalize).data?.status ?? "?"}`,
  );
  assert(finalize.status === 200, `finalize 失败：${finalize.status} ${JSON.stringify(finalize.body)}`);

  const finalizeAgain = await http(sessionA, "POST", `/web/cloud-drive/uploads/${uploadId}/finalize`);
  record(
    "A 重复提交（幂等）",
    "POST",
    `/web/cloud-drive/uploads/${uploadId}/finalize`,
    finalizeAgain,
    `status=${bodyOf<{ data?: { status?: string } }>(finalizeAgain).data?.status ?? "?"}`,
  );

  const consumed = await http(sessionA, "GET", `/web/cloud-drive/uploads/${uploadId}`);
  record(
    "A 已消费会话查询",
    "GET",
    `/web/cloud-drive/uploads/${uploadId}`,
    consumed,
    `code=${errorCode(consumed)}`,
    [410],
  );
  assert(
    consumed.status === 410 && errorCode(consumed) === "CLOUD_DRIVE_UPLOAD_GONE",
    `已消费会话应为 410 CLOUD_DRIVE_UPLOAD_GONE，实际 ${consumed.status} ${errorCode(consumed)}`,
  );

  // ── A：元数据 / 版本 / 下载（整文件 + Range） ────────────
  const stat = await http(sessionA, "GET", `/web/cloud-drive/files/${fileId}`);
  record(
    "A 文件元数据",
    "GET",
    `/web/cloud-drive/files/${fileId}`,
    stat,
    `name=${bodyOf<{ data?: { name?: string } }>(stat).data?.name ?? "?"} size=${bodyOf<{ data?: { sizeBytes?: number } }>(stat).data?.sizeBytes ?? "?"}`,
  );
  assert(stat.status === 200, `元数据失败：${stat.status}`);

  const versions = await http(sessionA, "GET", `/web/cloud-drive/files/${fileId}/versions`);
  const versionCount = (bodyOf<{ data?: { items?: unknown[] } }>(versions).data?.items ?? []).length;
  record("A 历史版本", "GET", `/web/cloud-drive/files/${fileId}/versions`, versions, `items=${versionCount}`);
  assert(versions.status === 200 && versionCount >= 1, `版本列表失败：${versions.status}`);

  const fullContent = await http(sessionA, "GET", `/web/cloud-drive/files/${fileId}/content`);
  const disposition = fullContent.headers.get("content-disposition") ?? "";
  record(
    "A 整文件下载",
    "GET",
    `/web/cloud-drive/files/${fileId}/content`,
    fullContent,
    `bytes=${fullContent.status === 200 ? content.length : "?"} disposition=${disposition.slice(0, 60)}`,
  );
  assert(fullContent.status === 200, `整文件下载失败：${fullContent.status}`);
  assert(disposition.startsWith("attachment;"), `下载应保持 attachment 语义：${disposition}`);

  const ranged = await http(sessionA, "GET", `/web/cloud-drive/files/${fileId}/content`, {
    headers: { range: "bytes=0-4" },
  });
  record(
    "A Range 下载",
    "GET",
    `/web/cloud-drive/files/${fileId}/content`,
    ranged,
    `range=${ranged.headers.get("content-range") ?? "?"}`,
    [206],
  );
  assert(ranged.status === 206, `Range 下载应为 206，实际 ${ranged.status}`);

  // ── A：改名（中文名，验证 RFC 5987） ─────────────────────
  const renamed = `重命名 说明-${Date.now()}.txt`;
  const move = await http(sessionA, "PATCH", `/web/cloud-drive/files/${fileId}/location`, { json: { name: renamed } });
  record("A 改名", "PATCH", `/web/cloud-drive/files/${fileId}/location`, move, `name=${renamed}`);
  assert(move.status === 200, `改名失败：${move.status} ${JSON.stringify(move.body)}`);

  const renamedContent = await http(sessionA, "GET", `/web/cloud-drive/files/${fileId}/content`);
  const renamedDisposition = renamedContent.headers.get("content-disposition") ?? "";
  record(
    "A 改后下载文件名",
    "GET",
    `/web/cloud-drive/files/${fileId}/content`,
    renamedContent,
    `disposition=${renamedDisposition.slice(0, 100)}`,
  );
  assert(
    renamedDisposition.includes("filename*=UTF-8''"),
    `Content-Disposition 缺少 RFC 5987 文件名：${renamedDisposition}`,
  );

  // ── A：搜索（最终一致，最多等 15s） ──────────────────────
  let search = await http(sessionA, "POST", "/web/cloud-drive/search", { json: { query: "hello", limit: 20 } });
  let hits = (bodyOf<{ data?: { items?: unknown[] } }>(search).data?.items ?? []).length;
  for (let attempt = 0; attempt < 15 && search.status === 200 && hits === 0; attempt += 1) {
    await Bun.sleep(1000);
    search = await http(sessionA, "POST", "/web/cloud-drive/search", { json: { query: "hello", limit: 20 } });
    hits = (bodyOf<{ data?: { items?: unknown[] } }>(search).data?.items ?? []).length;
  }
  record("A 搜索", "POST", "/web/cloud-drive/search", search, `hits=${hits}（最终一致，允许短暂为空）`);
  assert(search.status === 200, `搜索失败：${search.status}`);

  // ── A：删除 → 回收站 → 恢复 ─────────────────────────────
  const removed = await http(sessionA, "DELETE", `/web/cloud-drive/files/${fileId}`);
  record(
    "A 删除",
    "DELETE",
    `/web/cloud-drive/files/${fileId}`,
    removed,
    `state=${bodyOf<{ data?: { state?: string } }>(removed).data?.state ?? "?"}`,
  );
  assert(removed.status === 200, `删除失败：${removed.status} ${JSON.stringify(removed.body)}`);

  const missing = await http(sessionA, "GET", `/web/cloud-drive/files/${fileId}`);
  record("A 删除后读取", "GET", `/web/cloud-drive/files/${fileId}`, missing, `code=${errorCode(missing)}`, [404]);
  assert(missing.status === 404, `删除后读取应为 404，实际 ${missing.status}`);

  const trash = await http(sessionA, "GET", "/web/cloud-drive/trash");
  const entries =
    bodyOf<{
      data?: { items?: Array<{ id?: string; rootFileId?: string; file?: { metadataRevision?: number } }> };
    }>(trash).data?.items ?? [];
  const entry = entries.find((item) => item.rootFileId === fileId);
  const trashId = entry?.id ?? "";
  record("A 回收站列表", "GET", "/web/cloud-drive/trash", trash, `items=${entries.length} trashId=${trashId}`);
  assert(trash.status === 200 && trashId, `回收站未找到刚删除的条目：${trash.status}`);

  const restored = await http(sessionA, "POST", `/web/cloud-drive/trash/${trashId}/restore`, {
    json: { expectedMetadataRevision: entry?.file?.metadataRevision ?? 1 },
  });
  record(
    "A 恢复",
    "POST",
    `/web/cloud-drive/trash/${trashId}/restore`,
    restored,
    `state=${bodyOf<{ data?: { state?: string } }>(restored).data?.state ?? "?"}`,
  );
  assert(restored.status === 200, `恢复失败：${restored.status} ${JSON.stringify(restored.body)}`);

  const restoredStat = await http(sessionA, "GET", `/web/cloud-drive/files/${fileId}`);
  record(
    "A 恢复后读取",
    "GET",
    `/web/cloud-drive/files/${fileId}`,
    restoredStat,
    `lifecycle=${bodyOf<{ data?: { lifecycle?: string } }>(restoredStat).data?.lifecycle ?? "?"}`,
  );
  assert(restoredStat.status === 200, `恢复后读取失败：${restoredStat.status}`);

  // ── 隔离：B 看不到 / 读不到 / 删不到 A 的文件 ────────────
  const bRoot = await http(sessionB, "GET", "/web/cloud-drive/files");
  const bNames = (bodyOf<{ data?: { items?: Array<{ name?: string }> } }>(bRoot).data?.items ?? []).map(
    (item) => item.name,
  );
  record(
    "B 根列表",
    "GET",
    "/web/cloud-drive/files",
    bRoot,
    `items=${bNames.length} 不含A条目=${!bNames.includes(dirName)}`,
  );
  assert(bRoot.status === 200, `B 列表失败：${bRoot.status}`);

  const isolationChecks: Array<{ label: string; method: string; path: string; result: HttpResult }> = [
    {
      label: "B 读 A 目录",
      method: "GET",
      path: `/web/cloud-drive/files/${dirId}`,
      result: await http(sessionB, "GET", `/web/cloud-drive/files/${dirId}`),
    },
    {
      label: "B 读 A 文件",
      method: "GET",
      path: `/web/cloud-drive/files/${fileId}`,
      result: await http(sessionB, "GET", `/web/cloud-drive/files/${fileId}`),
    },
    {
      label: "B 下载 A 文件",
      method: "GET",
      path: `/web/cloud-drive/files/${fileId}/content`,
      result: await http(sessionB, "GET", `/web/cloud-drive/files/${fileId}/content`),
    },
    {
      label: "B 删 A 文件",
      method: "DELETE",
      path: `/web/cloud-drive/files/${fileId}`,
      result: await http(sessionB, "DELETE", `/web/cloud-drive/files/${fileId}`),
    },
    {
      label: "B 列 A 目录",
      method: "GET",
      path: `/web/cloud-drive/files?parentId=${dirId}`,
      result: await http(sessionB, "GET", `/web/cloud-drive/files?parentId=${dirId}`),
    },
  ];
  for (const check of isolationChecks) {
    record(check.label, check.method, check.path, check.result, `code=${errorCode(check.result)}`, [404]);
    assert(check.result.status === 404, `${check.label} 应为 404，实际 ${check.result.status}`);
  }

  // ── 隔离：上传会话跨用户不可见 ──────────────────────────
  const isolationUpload = await http(sessionA, "POST", "/web/cloud-drive/uploads", {
    json: { parentId: dirId, name: `isolation-${Date.now()}.txt`, sizeBytes: 4, contentType: "text/plain" },
  });
  const isolationUploadId = bodyOf<{ data?: { uploadId?: string } }>(isolationUpload).data?.uploadId ?? "";
  assert(isolationUpload.status === 200 && isolationUploadId, "隔离用上传会话创建失败");
  const foreignUpload = await http(sessionB, "GET", `/web/cloud-drive/uploads/${isolationUploadId}`);
  record(
    "B 读 A 上传会话",
    "GET",
    `/web/cloud-drive/uploads/${isolationUploadId}`,
    foreignUpload,
    `code=${errorCode(foreignUpload)}`,
    [404],
  );
  assert(foreignUpload.status === 404, `跨用户上传会话应为 404，实际 ${foreignUpload.status}`);
  const abandoned = await http(sessionA, "POST", `/web/cloud-drive/uploads/${isolationUploadId}/abandon`);
  record(
    "A 放弃隔离用上传",
    "POST",
    `/web/cloud-drive/uploads/${isolationUploadId}/abandon`,
    abandoned,
    `status=${bodyOf<{ data?: { status?: string } }>(abandoned).data?.status ?? "?"}`,
  );
  assert(abandoned.status === 200, `放弃上传失败：${abandoned.status}`);

  console.log("\n| 步骤 | 方法 | 路径 | HTTP | 关键结果 |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const row of rows) {
    console.log(
      `| ${row.step} | ${row.method} | \`${row.path}\` | ${row.status} | ${row.detail.replaceAll("|", "\\|")} |`,
    );
  }
  console.log(`\n用户 A：${sessionA.email}（${sessionA.userId}）`);
  console.log(`用户 B：${sessionB.email}（${sessionB.userId}）`);
}

async function cleanup(): Promise<void> {
  if (process.env.CLOUD_DRIVE_SMOKE_CLEANUP !== "1" || !DATABASE_URL || createdUsers.length === 0) return;
  const { Client } = await import("pg");
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const ids = createdUsers.map((user) => user.userId);
    await client.query(
      "DELETE FROM organization WHERE id IN (SELECT organization_id FROM member WHERE user_id = ANY($1::text[]))",
      [ids],
    );
    await client.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [ids]);
    console.log(`\n已清理 ${ids.length} 个联调用户及其个人组织`);
  } finally {
    await client.end();
  }
}

try {
  await main();
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  console.error(`\n联调失败：${failures.join("；")}`);
  process.exitCode = 1;
} finally {
  await cleanup().catch((error) => {
    console.error(`清理失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export {};
