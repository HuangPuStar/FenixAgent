import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOG_SOURCE_ID_PATTERN, listLogSources, logSourceId, parseLogSourceFileName, resolveLogDir } from "../sources";

describe("已知日志源的只读枚举", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fenix-log-sources-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // 白名单是「控制台能看到哪些日志」的唯一来源：只认写入侧的 {prefix}.{yyyy-MM-dd}.log 命名，
  // 目录里其它 .log（别的进程、手工放置、被改造过的名字）都不进入投影面。
  test("只枚举写入侧命名规则内的日志文件", async () => {
    await writeFile(join(root, "rcs.2026-09-20.log"), "app");
    await writeFile(join(root, "rcs.err.2026-09-20.log"), "error");
    for (const ignored of [
      "rcs.log",
      "rcs.err.log",
      "legacy.log",
      "other.2026-09-20.log",
      "rcs.2026-09-20.txt",
      "rcs.2026-9-20.log",
      "rcs.2026-09-20.log.bak",
    ]) {
      await writeFile(join(root, ignored), "not a source");
    }
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "rcs.2026-09-20.log"), "nested");

    expect(listLogSources(root).map((source) => source.fileName)).toEqual([
      "rcs.2026-09-20.log",
      "rcs.err.2026-09-20.log",
    ]);
  });

  // 目录不存在是首次启动的正常状态（尚未写过任何日志），返回空表而不是抛错。
  test("目录不存在时返回空表", () => {
    expect(listLogSources(join(root, "missing"))).toEqual([]);
  });

  // 只认常规文件：同名的目录与符号链接都不算日志源——符号链接会把读取引到白名单之外的路径。
  test("忽略同名目录与符号链接", async () => {
    await mkdir(join(root, "rcs.2020-01-01.log"));
    await writeFile(join(root, "target.log"), "outside");
    await symlink(join(root, "target.log"), join(root, "rcs.2020-01-02.log"));
    await writeFile(join(root, "rcs.2020-01-03.log"), "regular");

    expect(listLogSources(root).map((source) => source.fileName)).toEqual(["rcs.2020-01-03.log"]);
  });

  // 排序确定（日期倒序、同日期 app 在前），前端选择器与用例断言都依赖这个顺序。
  test("按日期倒序排列且同类前缀稳定", async () => {
    await writeFile(join(root, "rcs.2026-09-18.log"), "older");
    await writeFile(join(root, "rcs.err.2026-09-20.log"), "newer error");
    await writeFile(join(root, "rcs.2026-09-20.log"), "newer app");

    expect(listLogSources(root).map((source) => source.id)).toEqual([
      "app-2026-09-20",
      "error-2026-09-20",
      "app-2026-09-18",
    ]);
  });

  // ID 形状与枚举结果同源：合法的 kind + 日期能命中，文件名、路径、非法日期一律不合法——
  // 这让「客户端传路径」在协议层就是 400，而不是靠路径拼接后的兜底校验。
  test("日志源 ID 形状只接受 kind 与日期", () => {
    const date = "2026-09-20";
    expect(LOG_SOURCE_ID_PATTERN.test(logSourceId("app", date))).toBe(true);
    expect(LOG_SOURCE_ID_PATTERN.test(logSourceId("error", date))).toBe(true);

    for (const rejected of [
      "rcs.2026-09-20.log",
      "app-2026-9-20",
      "app-20260920",
      "App-2026-09-20",
      "app-2026-09-20.log",
      "../app-2026-09-20",
      "/etc/passwd",
      "error-2026-09-20 ",
    ]) {
      expect({ rejected, accepted: LOG_SOURCE_ID_PATTERN.test(rejected) }).toEqual({ rejected, accepted: false });
    }
  });

  // 解析器对两个前缀的判定必须无歧义：`rcs.err.*` 不能被 `rcs.` 前缀误判成日期段 `err.…`。
  test("日期前缀按最长匹配解析", () => {
    expect(parseLogSourceFileName("rcs.2026-09-20.log")).toEqual({ kind: "app", date: "2026-09-20" });
    expect(parseLogSourceFileName("rcs.err.2026-09-20.log")).toEqual({ kind: "error", date: "2026-09-20" });
    expect(parseLogSourceFileName("rcs.err.log")).toBeNull();
  });

  // 目录解析归 logger 独占：`LOG_DIR` 在调用时读取（进程启动后仍可改），缺省落到 cwd 下的 logs。
  // 读取侧因此不必自己解析环境变量，也不会与写入侧指向不同目录。
  test("LOG_DIR 在调用时生效并提供绝对路径", () => {
    const original = process.env.LOG_DIR;
    try {
      process.env.LOG_DIR = "custom-logs";
      expect(resolveLogDir()).toBe(join(process.cwd(), "custom-logs"));

      Reflect.deleteProperty(process.env, "LOG_DIR");
      expect(resolveLogDir()).toBe(join(process.cwd(), "logs"));
    } finally {
      if (original === undefined) Reflect.deleteProperty(process.env, "LOG_DIR");
      else process.env.LOG_DIR = original;
    }
  });
});
