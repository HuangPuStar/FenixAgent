/**
 * CloudDrive MCP 冒烟脚本（**默认不运行**）。
 *
 * 运行方式（worktree 根）：
 *
 * ```bash
 * CLOUD_DRIVE_MCP_SMOKE=1 \
 * FENIX_BASE_URL=http://127.0.0.1:3102 \
 * CLOUDDRIVE_MCP_TOKEN_SECRET=<与目标服务相同的密钥> \
 * bun run scripts/cloud-drive-mcp-smoke.ts
 * ```
 *
 * 前置：目标 Fenix 已配置 `CLOUDDRIVE_BASE_URL` / `CLOUDDRIVE_MASTER_KEY`，且与脚本共享
 * `CLOUDDRIVE_MCP_TOKEN_SECRET`。脚本自己签发两个用户的 token（不打印 token），只访问
 * `/mcp/cloud-drive`，不读取 master key。
 *
 * 覆盖：initialize、tools/list（scope 过滤）、me、list、search、mkdir、write_text、stat、
 * read_markdown（尽力轮询转换产物）、双用户隔离（跨用户 file_id → NOT_FOUND）。
 */

import { type CloudDriveMcpScope, issueCloudDriveMcpToken } from "@fenix/resource-cloud-drive/server";

interface RpcResult {
  readonly httpStatus: number;
  readonly jsonrpc: { result?: unknown; error?: { code: number; message: string } };
}

interface Row {
  readonly step: string;
  readonly status: string;
  readonly detail: string;
}

const ENABLED = process.env.CLOUD_DRIVE_MCP_SMOKE === "1" || process.argv.includes("--cloud-drive-mcp-smoke");
if (!ENABLED) {
  console.log("跳过 CloudDrive MCP 冒烟（设置 CLOUD_DRIVE_MCP_SMOKE=1 或传 --cloud-drive-mcp-smoke 运行）");
  process.exit(0);
}

const BASE_URL = (process.env.FENIX_BASE_URL ?? "http://127.0.0.1:3102").replace(/\/+$/, "");
const SECRET = process.env.CLOUDDRIVE_MCP_TOKEN_SECRET?.trim();
if (!SECRET) {
  console.error("缺少 CLOUDDRIVE_MCP_TOKEN_SECRET，无法签发冒烟 token");
  process.exit(2);
}

const suffix = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 4)}`;
const USER_A = process.env.CLOUD_DRIVE_MCP_SMOKE_USER_A ?? `mcp-smoke-a-${suffix}`;
const USER_B = process.env.CLOUD_DRIVE_MCP_SMOKE_USER_B ?? `mcp-smoke-b-${suffix}`;
const ORG = process.env.CLOUD_DRIVE_MCP_SMOKE_ORG ?? "smoke-org";

const rows: Row[] = [];
const failures: string[] = [];

function record(step: string, ok: boolean, detail: string): void {
  rows.push({ step, status: ok ? "ok" : "fail", detail });
  console.log(`[${ok ? "ok" : "fail"}] ${step} | ${detail}`);
  if (!ok) failures.push(step);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function token(scope: CloudDriveMcpScope, userId: string): Promise<string> {
  return issueCloudDriveMcpToken({ userId, organizationId: ORG, scope, ttlSeconds: 600, secret: SECRET });
}

/** stateless MCP：每个请求自带 Bearer，不存在会话 ID。 */
async function rpc(bearer: string, body: Record<string, unknown>, timeoutMs = 200_000): Promise<RpcResult> {
  const response = await fetch(`${BASE_URL}/mcp/cloud-drive`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  return { httpStatus: response.status, jsonrpc: parseRpcBody(text) };
}

function parseRpcBody(text: string): RpcResult["jsonrpc"] {
  if (!text) return {};
  // 服务端开了 enableJsonResponse；这里仍兼容 SSE 帧，避免协议协商变化让脚本失效。
  if (text.startsWith("event:") || text.startsWith("data:")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    return data ? (JSON.parse(data) as RpcResult["jsonrpc"]) : {};
  }
  return JSON.parse(text) as RpcResult["jsonrpc"];
}

async function callTool(bearer: string, name: string, args: Record<string, unknown> = {}) {
  const response = await rpc(bearer, {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/call",
    params: { name, arguments: args },
  });
  const result = response.jsonrpc.result as
    | { content?: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: unknown }
    | undefined;
  const text = result?.content?.find((item) => item.type === "text")?.text ?? "";
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  return { httpStatus: response.httpStatus, result, payload, error: response.jsonrpc.error };
}

function toolErrorCode(payload: unknown): string {
  const error = (payload as { error?: { code?: string } } | null)?.error;
  return error?.code ?? "";
}

async function listTools(bearer: string) {
  const response = await rpc(bearer, { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/list" });
  const tools = (response.jsonrpc.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? [];
  return tools.map((tool) => tool.name);
}

async function waitForMarkdown(
  bearer: string,
  fileId: string,
  attempts = 10,
): Promise<{ ok: boolean; code: string; detail: string }> {
  let lastCode = "";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const call = await callTool(bearer, "cloud_drive_read_markdown", { file_id: fileId });
    if (!call.result?.isError) {
      const structured = call.payload as { content?: string; nextCursor?: string | null } | null;
      return { ok: true, code: "", detail: `chars=${structured?.content?.length ?? 0}` };
    }
    lastCode = toolErrorCode(call.payload);
    // 转换未完成（上游 404）时轮询；其它错误直接返回。
    if (lastCode !== "NOT_FOUND") return { ok: false, code: lastCode, detail: "非转换未完成错误" };
    await Bun.sleep(2_000);
  }
  return { ok: false, code: lastCode || "NOT_FOUND", detail: `${attempts} 次轮询后转换仍未就绪` };
}

async function main(): Promise<void> {
  const readA = await token("read", USER_A);
  const writeA = await token("write", USER_A);
  const writeB = await token("write", USER_B);

  // ── 协议与 scope ──────────────────────────────────────
  const initialized = await rpc(readA, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "cloud-drive-mcp-smoke", version: "1" },
    },
  });
  const serverInfo = (initialized.jsonrpc.result as { serverInfo?: { name?: string } } | undefined)?.serverInfo;
  record(
    "initialize",
    initialized.httpStatus === 200 && serverInfo?.name === "cloud-drive-mcp",
    `server=${serverInfo?.name ?? "?"}`,
  );

  const readTools = await listTools(readA);
  const writeTools = await listTools(writeA);
  record(
    "tools/list scope=read",
    readTools.length === 7 && !readTools.includes("cloud_drive_write_text"),
    `tools=${readTools.join(",")}`,
  );
  record(
    "tools/list scope=write",
    writeTools.length === 11 && writeTools.includes("cloud_drive_write_text"),
    `tools=${writeTools.length}`,
  );

  // ── A：主体 / 列表 / 搜索 ─────────────────────────────
  const me = await callTool(readA, "cloud_drive_me");
  record("A me", !me.result?.isError, `subject=${(me.payload as { subject?: string } | null)?.subject ?? "?"}`);

  const root = await callTool(readA, "cloud_drive_list");
  record(
    "A 根列表",
    !root.result?.isError,
    `items=${(root.payload as { items?: unknown[] } | null)?.items?.length ?? 0}`,
  );

  const search = await callTool(readA, "cloud_drive_search", { query: "smoke", limit: 5 });
  record(
    "A 搜索",
    !search.result?.isError,
    `items=${(search.payload as { items?: unknown[] } | null)?.items?.length ?? 0}`,
  );

  // ── A：写目录与文本（scope=write） ────────────────────
  const dirName = `mcp-smoke-${suffix}`;
  const mkdir = await callTool(writeA, "cloud_drive_mkdir", { name: dirName });
  const dirId = (mkdir.payload as { file_id?: string } | null)?.file_id ?? "";
  record("A mkdir", !mkdir.result?.isError && Boolean(dirId), `dir=${dirName} id=${dirId}`);
  assert(dirId, "建目录失败，后续写文件无法继续");

  const fileName = `note-${suffix}.md`;
  const content = `# smoke ${suffix}\n\n这是一次 CloudDrive MCP 冒烟写入。\n`;
  const write = await callTool(writeA, "cloud_drive_write_text", {
    name: fileName,
    parent_id: dirId,
    content,
    content_type: "text/markdown; charset=utf-8",
  });
  const fileId = (write.payload as { file_id?: string } | null)?.file_id ?? "";
  record(
    "A write_text",
    !write.result?.isError && Boolean(fileId),
    `file=${fileName} id=${fileId} bytes=${content.length}`,
  );
  assert(fileId, "写文件失败，无法继续读/隔离验证");

  const stat = await callTool(readA, "cloud_drive_stat", { file_id: fileId });
  record(
    "A stat",
    !stat.result?.isError,
    `name=${(stat.payload as { name?: string } | null)?.name ?? "?"} size=${(stat.payload as { sizeBytes?: number } | null)?.sizeBytes ?? "?"}`,
  );

  const markdown = await waitForMarkdown(readA, fileId);
  record("A read_markdown", markdown.ok, markdown.ok ? markdown.detail : `code=${markdown.code} ${markdown.detail}`);

  const versions = await callTool(readA, "cloud_drive_versions", { file_id: fileId });
  record(
    "A versions",
    !versions.result?.isError,
    `count=${(versions.payload as { items?: unknown[] } | null)?.items?.length ?? 0}`,
  );

  const trash = await callTool(readA, "cloud_drive_trash_list");
  record(
    "A trash_list",
    !trash.result?.isError,
    `items=${(trash.payload as { items?: unknown[] } | null)?.items?.length ?? 0}`,
  );

  // ── 双用户隔离：B 用 A 的 fileId 一律 NOT_FOUND ───────
  const crossStat = await callTool(writeB, "cloud_drive_stat", { file_id: fileId });
  record(
    "B 跨用户 stat",
    crossStat.result?.isError === true && toolErrorCode(crossStat.payload) === "NOT_FOUND",
    `code=${toolErrorCode(crossStat.payload)}`,
  );

  const crossRename = await callTool(writeB, "cloud_drive_rename", { file_id: fileId, name: "hijacked.md" });
  record(
    "B 跨用户 rename",
    crossRename.result?.isError === true && toolErrorCode(crossRename.payload) === "NOT_FOUND",
    `code=${toolErrorCode(crossRename.payload)}`,
  );

  const bRoot = await callTool(writeB, "cloud_drive_list");
  const bNames = ((bRoot.payload as { items?: Array<{ name?: string }> } | null)?.items ?? []).map((item) => item.name);
  record("B 根列表不含 A 目录", !bNames.includes(dirName), `items=${bNames.length}`);

  // ── 参数越权：uid 被拒绝 ──────────────────────────────
  const forged = await rpc(writeA, {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/call",
    params: { name: "cloud_drive_list", arguments: { uid: USER_B } },
  });
  const forgedText = JSON.stringify(forged.jsonrpc);
  const forgedResult = forged.jsonrpc.result as { isError?: boolean } | undefined;
  // SDK 把入参校验失败包在 `result.isError`（JSON-RPC 层仍是成功响应），两种形态都算拒绝。
  record(
    "越权字段被拒绝",
    (forged.jsonrpc.error?.code === -32602 || forgedResult?.isError === true) && !forgedText.includes(USER_B),
    `code=${forged.jsonrpc.error?.code ?? (forgedResult?.isError ? -32602 : "result")}`,
  );

  summarize();
}

function summarize(): void {
  console.log("\n=== 汇总 ===");
  console.table(rows);
  if (failures.length > 0) {
    console.error(`失败 ${failures.length} 项：${failures.join("、")}`);
    process.exit(1);
  }
  console.log(`全部 ${rows.length} 项通过；测试用户 A=${USER_A} B=${USER_B}（文件保留在云盘，可按需清理）`);
}

await main();
