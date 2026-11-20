import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 真正写入日志的访问、错误及异常诊断都不能泄漏 Office URL 令牌或回调正文。
test("Office request logs redact reference paths and untrusted error details", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "office-log-test-"));
  const loggerUrl = pathToFileURL(join(import.meta.dir, "../plugins/logger.ts")).href;
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production", LOG_FORMAT: "json", LOG_DIR: logDir };
  delete env.BUN_TEST;
  const code = `
    import { deriveRequestId, logResponse, logError } from ${JSON.stringify(loggerUrl)};
    for (const kind of ["documents", "callbacks"]) {
      const request = new Request("http://localhost/office/" + kind + "/sensitive-reference-value?jwt=secret-query", { method: kind === "documents" ? "GET" : "POST" });
      deriveRequestId({ request });
      logResponse({ request, set: { status: 200 } });
      const error = Object.assign(new Error("Provider failed " + request.url + " signed-body-secret"), { cause: new Error("nested-secret") });
      logError({ request, error, set: { status: 500, headers: {} } });
      logError({ request, error: "untyped signed-body-secret " + request.url, set: { status: 400, headers: {} } });
    }
  `;
  try {
    const child = Bun.spawn([process.execPath, "--eval", code], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    for (const forbidden of ["sensitive-reference-value", "secret-query", "signed-body-secret", "nested-secret"])
      expect(stdout).not.toContain(forbidden);
    const entries = stdout
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line) as { msg: string; path?: string });
    expect(entries).toHaveLength(6);
    expect(entries.some((entry) => `${entry.msg} ${entry.path ?? ""}`.includes("/office/documents/[REDACTED]"))).toBe(
      true,
    );
    expect(entries.some((entry) => `${entry.msg} ${entry.path ?? ""}`.includes("/office/callbacks/[REDACTED]"))).toBe(
      true,
    );
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
});
