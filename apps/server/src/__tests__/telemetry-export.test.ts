import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

// 源码和生产同形的外置依赖 bundle 都要实际导出三信号，日志只能一次且不能泄漏内容。
test("Bun 源码与 bundle 使用同一 SDK 导出三信号", async () => {
  const root = new URL("../../../../", import.meta.url).pathname;
  const output = await mkdtemp(join(root, ".tmp-telemetry-"));
  try {
    const fixture = "apps/server/src/__tests__/fixtures/telemetry-export-probe.ts";
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        fixture,
        "--target=bun",
        "--splitting",
        "--packages=external",
        "--external",
        "@fenix/logger",
        "--external",
        "@fenix/logger/*",
        "--outdir",
        output,
      ],
      { cwd: root, env: { ...process.env, NODE_ENV: "production" }, stdout: "pipe", stderr: "pipe" },
    );
    expect(await build.exited).toBe(0);
    for (const path of [join(root, fixture), join(output, "telemetry-export-probe.js")]) {
      const secret = crypto.randomUUID();
      const proc = Bun.spawn([process.execPath, path], {
        cwd: root,
        env: {
          ...process.env,
          NODE_ENV: "production",
          LOG_FORMAT: "json",
          LOG_DIR: join(output, "logs"),
          TELEMETRY_PROBE_SECRET: secret,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      expect({ exitCode: await proc.exited, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(stdout).not.toContain(secret);
      const summary = stdout.trim().split("\n").at(-1);
      expect(JSON.parse(summary ?? "{}")).toEqual({
        signals: ["/v1/logs", "/v1/metrics", "/v1/traces"],
        uniqueLogs: 1,
        hasFields: true,
        hasTraceCorrelation: true,
        hasError: true,
        hasPg: true,
        hasRedis: true,
        leakedSecret: false,
        leakedSql: false,
      });
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}, 30_000);
