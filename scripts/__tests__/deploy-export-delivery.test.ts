/**
 * `docker/deploy.sh export` 的交付面契约：生产部署不在仓库工作区里跑——编排与脚本都受版本控制，
 * 下一次 `git pull` 会就地改写它们，而配置面（各 `.env` / `deploy.env`）与数据目录还停在旧结构上，
 * 容器重建时故障现场很难归因。
 *
 * 这条命令是部署机上的第一步，三个性质必须守住：交付面**只含受版本控制的文件**（真实 `.env`、`data/`、
 * `dev/` 与本地工具都不进去）、已存在的文件**一律不覆盖**（目标里那份可能正被运行中的部署使用）、
 * 目标目录**不能在仓库内**（否则隔离失效）。按真实调用形态跑：直接执行 `docker/deploy.sh`（含子命令分发），
 * fixture 一律在临时目录里。
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const DEPLOY_SCRIPT = join(REPOSITORY_ROOT, "docker/deploy.sh");
/** 仓库内的非法导出目标：断言它自始至终没被创建过。 */
const FORBIDDEN_TARGET = join(REPOSITORY_ROOT, "docker-export-should-refuse");

const tempRoot = await mkdtemp(join(tmpdir(), "deploy-export-"));
afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
  rmSync(FORBIDDEN_TARGET, { recursive: true, force: true });
});

interface ExportResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** 跑一次真实的 `docker/deploy.sh export`；目标目录由调用方给。 */
async function runExport(target: string): Promise<ExportResult> {
  const child = Bun.spawn(["bash", DEPLOY_SCRIPT, "export", target], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/** 交付面里的所有相对路径（含 `docker/` 前缀），按字典序。 */
function deliveryPaths(root: string, prefix = "docker"): string[] {
  const absolute = join(root, prefix);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => {
      const path = `${prefix}/${entry.name}`;
      return entry.isDirectory() ? deliveryPaths(root, path) : [path];
    })
    .sort();
}

// 交付面是「编排的快照」而不是「本机状态的副本」：受版本控制的文件齐了，本机配置、数据与本地工具都不在内。
test("导出的交付面只含受版本控制的编排与脚本", async () => {
  const target = join(tempRoot, "delivery");
  const result = await runExport(target);

  expect(result.stderr).not.toContain("错误");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("排除目录：dev、compose-explorer");

  const paths = deliveryPaths(target);
  expect(paths.length).toBeGreaterThan(50);
  // 部署机第一步要用到的三样：脚本、主服务编排、配置模板。
  for (const required of [
    "docker/deploy.sh",
    "docker/lib/config.sh",
    "docker/main/docker-compose.yml",
    "docker/main/.env.example",
    "docker/deploy.env.example",
  ]) {
    expect({ required, present: paths.includes(required) }).toEqual({ required, present: true });
  }
  // 本机的真实配置与数据不进去：`.env` / `deploy.env` 会被目标机上的 init 重新落成。
  expect(paths.filter((path) => path.endsWith(".env"))).toEqual([]);
  expect(paths.filter((path) => path.includes("/data/") || path.endsWith("/data"))).toEqual([]);
  // 只在仓库里成立的目录不随交付面外发（dev 形态由仓库根编排 include、compose-explorer 读仓库根）。
  expect(paths.filter((path) => path.startsWith("docker/dev/"))).toEqual([]);
  expect(paths.filter((path) => path.startsWith("docker/compose-explorer/"))).toEqual([]);
});

// 幂等：第二次导出不该再写任何文件，也不该把上一份报告成「内容不同」。
test("重复导出是幂等的", async () => {
  const target = join(tempRoot, "idempotent");
  const first = await runExport(target);
  const second = await runExport(target);

  expect([first.exitCode, second.exitCode]).toEqual([0, 0]);
  expect(second.stdout).toContain("新增 0 个文件");
  expect(second.stderr).not.toContain("均未覆盖");
});

// 已存在的文件一律不覆盖：目标里那份可能正被运行中的部署使用，静默替换等于替部署方改生产。
test("目标里已存在且内容不同的文件不被覆盖，只报告", async () => {
  const target = join(tempRoot, "existing");
  await runExport(target);
  const edited = join(target, "docker/deploy.sh");
  writeFileSync(edited, "# 部署机上手改过\n", "utf8");

  const result = await runExport(target);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("均未覆盖");
  expect(result.stderr).toContain("docker/deploy.sh");
  expect(readFileSync(edited, "utf8")).toBe("# 部署机上手改过\n");
});

// 目标落在仓库内等于隔离失效：拉取代码照样会改写正在运行的那份交付面。
test("目标目录落在仓库内时拒绝导出，且不在仓库里留下任何东西", async () => {
  const result = await runExport(FORBIDDEN_TARGET);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("不能落在仓库内");
  expect(existsSync(FORBIDDEN_TARGET)).toBe(false);
});

// 少了目标目录就不能猜：这一步要落一整套编排，猜错位置等于在生产机上写错地方。
test("未给目标目录时报用法并失败", async () => {
  const child = Bun.spawn(["bash", DEPLOY_SCRIPT, "export"], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

  expect(exitCode).toBe(1);
  expect(stderr).toContain("用法");
  expect(child.stdout).toBeDefined();
});
