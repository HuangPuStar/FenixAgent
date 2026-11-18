import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistorySpool } from "../sync/history/spool";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

// 同一段的高频追加只持有一个写句柄；封存、完成与失败都必须释放句柄。
test("连续追加按段复用写句柄且所有终态都关闭文件", async () => {
  const basePath = await fs.mkdtemp(join(tmpdir(), "spool-writer-"));
  roots.push(basePath);
  const spool = new HistorySpool(
    { basePath, segmentBytes: 64, taskQuotaBytes: 1024, processQuotaBytes: 4096 },
    { now: () => 1 },
  );
  const open = spyOn(fs, "open");
  try {
    for (const finish of ["seal", "complete", "fail"] as const) {
      const task = await spool.beginTask(finish);
      const before = open.mock.calls.length;
      for (let index = 0; index < 10; index++) await task.append(new Uint8Array(10).fill(index));
      if (finish === "seal") await task.seal();
      if (finish === "complete") await spool.completeTask(finish);
      if (finish === "fail") await spool.failTask(finish, "synthetic failure");
      expect(open.mock.calls.length - before).toBe(2);
      for (const result of open.mock.results.slice(before)) {
        if (result.type === "return") expect((await result.value).fd).toBe(-1);
      }
      if (finish === "seal") {
        const bytes = await fs.readFile(join(basePath, finish, "segment-000001.bin"));
        expect([...bytes]).toEqual([
          6,
          6,
          6,
          6,
          6,
          6,
          ...Array<number>(10).fill(7),
          ...Array<number>(10).fill(8),
          ...Array<number>(10).fill(9),
        ]);
        await spool.completeTask(finish);
      }
    }
    expect(spool.stats().totalBytes).toBe(0);
  } finally {
    open.mockRestore();
    for (const name of ["seal", "complete", "fail"]) await spool.completeTask(name);
  }
});
