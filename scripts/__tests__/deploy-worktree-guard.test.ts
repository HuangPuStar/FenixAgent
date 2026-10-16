/**
 * `docker/deploy.sh` 的交付面守卫：`docker/` 落在 git 工作区里时，配置与发布命令（`init` / `validate` /
 * `up` / `deploy` / `config`）必须被拒——工作区里的那套环境会被下一次 `git pull`、切分支或 `clean` 就地改写，
 * 而配置面与数据目录还停在旧结构上，故障现场很难归因；提示要给出 `export` 这条出路。停止与查看
 * （`down` / `ps` / `logs`）只告警不阻塞，应急时不该被挡在门外；`export` 是唯一允许在仓库里执行的命令
 * （它就是挪到工作区外的入口，其行为契约见 deploy-export-delivery.test.ts）。
 *
 * 判定按 `SCRIPT_DIR` 问 git（`rev-parse --show-toplevel`），因此分两层测：把函数定义截出来在隔离 bash 里
 * 按不同 `SCRIPT_DIR` 判定（仓库内、仓库内的深层目录、非 git 目录两侧都覆盖），再跑一次真实命令确认仓库里
 * 确实被拦下。真实命令只挑 `validate`：它在守卫之后才需要 docker 与既有配置，被拦下时没有任何副作用——
 * `up` / `down` 会真动本机容器，不能进测试。
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const DEPLOY_SCRIPT = join(REPOSITORY_ROOT, "docker/deploy.sh");
const SCRIPT_TEXT = readFileSync(DEPLOY_SCRIPT, "utf8");

const tempRoot = await mkdtemp(join(tmpdir(), "deploy-guard-"));
afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(command: string[], cwd: string): Promise<RunResult> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * 截出 `guard_worktree` 定义（连同它上面的说明注释）：守卫的判定只依赖 `SCRIPT_DIR` 与 git，把函数单独拿出来
 * 就能在任意目录上验证取向，不必真跑 `up` / `down` 动到本机容器。
 */
function guardFunction(): string {
  const start = SCRIPT_TEXT.indexOf("# 交付面守卫");
  const end = SCRIPT_TEXT.indexOf("\n}\n", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SCRIPT_TEXT.slice(start, end + 3);
}

/** 在隔离 bash 里只加载守卫函数后判定一次：`block` 档应退出 1，`warn` 档应退出 0 且只有警告。 */
async function runGuard(scriptDir: string, mode: "block" | "warn"): Promise<RunResult> {
  const harness = [
    "set -euo pipefail",
    'SCRIPT_DIR="$1"',
    `log() { printf '[deploy] %s\\n' "$*"; }`,
    `warn() { printf '[deploy] 警告：%s\\n' "$*" >&2; }`,
    `die() { printf '[deploy] 错误：%s\\n' "$*" >&2; exit 1; }`,
    guardFunction(),
    `guard_worktree validate ${mode}`,
  ].join("\n");
  const harnessPath = join(tempRoot, `guard-${mode}.sh`);
  await Bun.write(harnessPath, harness);
  return run(["bash", harnessPath, scriptDir], tempRoot);
}

// 仓库内的目录一律拦下：脚本目录（docker/）与它下面的任意深度都算「在项目下」，因为 git 报出的是工作区根。
test("脚本位于仓库内（含深层目录）时阻塞配置与发布命令", async () => {
  const atDocker = await runGuard(join(REPOSITORY_ROOT, "docker"), "block");
  expect(atDocker.exitCode).toBe(1);
  expect(atDocker.stderr).toContain("docker/ 位于 git 工作区");
  expect(atDocker.stderr).toContain("export");

  const deep = join(REPOSITORY_ROOT, "docker/main");
  mkdirSync(deep, { recursive: true });
  const atDeep = await runGuard(deep, "block");
  expect(atDeep.exitCode).toBe(1);
});

// 交付面在仓库外：没有 git 可用（部署机形态）就放行，守卫不参与——这是生产上的正常路径。
test("脚本位于非 git 目录时放行", async () => {
  const plain = join(tempRoot, "plain");
  mkdirSync(plain, { recursive: true });
  const result = await runGuard(plain, "block");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
});

// 外层是 git 仓库、docker/ 落在它深处时同样拦下：判定问的是 git 的工作区根，不是「同目录有没有 .git」。
test("脚本位于某个 git 仓库的深层目录时同样阻塞", async () => {
  const outer = join(tempRoot, "outer");
  const nested = join(outer, "opt/fenix/docker");
  mkdirSync(nested, { recursive: true });
  const init = await run(["git", "init", "-q", outer], tempRoot);
  expect(init.exitCode).toBe(0);

  const result = await runGuard(nested, "block");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("docker/ 位于 git 工作区");
});

// 停止与查看只告警：应急时不该被守卫挡在门外，因此 warn 档退出 0。
test("down / ps / logs 只告警不阻塞", async () => {
  const result = await runGuard(join(REPOSITORY_ROOT, "docker"), "warn");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("[deploy] 警告：docker/ 位于 git 工作区");
  expect(result.stderr).not.toContain("[deploy] 错误");
});

// 真实命令形态再确认一次：仓库里跑 validate 被守卫拦下，提示指向 export。
test("仓库里执行 validate 被拦下并提示先 export", async () => {
  const result = await run(["bash", DEPLOY_SCRIPT, "validate"], REPOSITORY_ROOT);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("[deploy] 错误：docker/ 位于 git 工作区");
  expect(result.stderr).toContain("./docker/deploy.sh export");
  expect(result.stdout).toBe("");
});
