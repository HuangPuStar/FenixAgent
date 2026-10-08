/**
 * `docker/lib/config.sh` 的 `ensure_workflow_platform_account_email`（部署期生成并固化平台上游账号邮箱）行为测试。
 *
 * 为什么要测 shell：这一步会**写进部署方的 docker/main/.env**（那是携带密钥的生产配置），三个性质必须守住——
 * 只补缺失、绝不覆盖已有值、重复执行是空操作；而它又不在任何生成器的 `--check` 覆盖里（`docker/` 不是生成物）。
 * 因此这里按脚本的真实调用形态跑：`docker/deploy.sh` 先定义 log / warn / die 与目录常量，再 source lib（lib 依赖
 * 调用方作用域，不能单独执行），fixture 一律在临时目录里，真实 `docker/main/.env` 不参与测试。
 */
import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const DOCKER_DIRECTORY = join(REPOSITORY_ROOT, "docker");
const CONFIG_LIB = join(DOCKER_DIRECTORY, "lib/config.sh");
const MAIN_ENV_TEMPLATE = join(DOCKER_DIRECTORY, "main/.env.example");
const KEY = "WORKFLOW_V2_PLATFORM_ACCOUNT_EMAIL";
/** 生成值的形状：本地部分是固定前缀 + 可选的主机名 slug（非法字符折成 '-'）；不含锚点，供拼整行正则。 */
const GENERATED_VALUE = /workflow-v2-platform(?:\+[a-z0-9-]{1,24})?@example\.com/;
/** fixture 的主机名：含大写与 '_'，用来核对 slug 的归一化。 */
const FAKE_HOSTNAME = "Prod-Host_01";
const EXPECTED_VALUE = "workflow-v2-platform+prod-host-01@example.com";
/** 写入文件的注（与实现里的文案一致：它是给部署方看的输出，不是内部实现细节）。 */
const NOTE_LINES = [
  "# 由 docker/deploy.sh 于部署期生成并固化：平台上游账号身份（不是密钥）。",
  "# 改值等于换上游账号：需要重新引导，并人工清理上游的旧账号（见 docker/workflow/README.md §5）。",
];

const tempRoot = await mkdtemp(join(tmpdir(), "deploy-platform-account-email-"));
const templateText = await readFile(MAIN_ENV_TEMPLATE, "utf8");
afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

/** 建一个只提供 `hostname` 的垫片目录：让「按主机名派生」这条口径在测试里是确定的；`null` 模拟取不到主机名。 */
async function hostnameShim(name: string | null): Promise<string> {
  const directory = await mkdtemp(join(tempRoot, "hostname-"));
  const body = name === null ? "#!/bin/sh\nexit 1\n" : `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(name)}\n`;
  const file = join(directory, "hostname");
  await writeFile(file, body);
  await chmod(file, 0o755);
  return directory;
}

interface EnsureResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** 在临时目录里跑一次生成；`hostname` 未指定时用 PATH 上的真实实现。 */
async function runEnsure(envFile: string, hostname?: string | null): Promise<EnsureResult> {
  const shim = hostname === undefined ? undefined : await hostnameShim(hostname);
  const script = [
    "set -euo pipefail",
    `SCRIPT_DIR=${JSON.stringify(DOCKER_DIRECTORY)}`,
    `REPO_ROOT=${JSON.stringify(REPOSITORY_ROOT)}`,
    `MAIN_ENV_FILE=${JSON.stringify(envFile)}`,
    `log() { printf '[deploy] %s\\n' "$*"; }`,
    `warn() { printf '[deploy] 警告：%s\\n' "$*" >&2; }`,
    `die() { printf '[deploy] 错误：%s\\n' "$*" >&2; exit 1; }`,
    `. ${JSON.stringify(CONFIG_LIB)}`,
    "ensure_workflow_platform_account_email",
  ].join("\n");
  const child = Bun.spawn(["bash", "-c", script], {
    env: shim === undefined ? process.env : { ...process.env, PATH: `${shim}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/** 写一份 fixture 的 `.env`；返回路径。模式用来核对「写入后权限不变」。 */
async function writeEnv(text: string, mode = 0o600): Promise<string> {
  const directory = await mkdtemp(join(tempRoot, "env-"));
  const file = join(directory, ".env");
  await writeFile(file, text);
  await chmod(file, mode);
  return file;
}

test("模板文件里缺失时：就地激活模板行，按主机名派生并固化", async () => {
  const envFile = await writeEnv(templateText, 0o640);
  const result = await runEnsure(envFile, FAKE_HOSTNAME);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain(`生成并固化 ${KEY}=${EXPECTED_VALUE}`);

  // 逐字节核对：模板里那一行注释被「两条注 + 值」就地替换，其余内容原样保留（不是另插一行、也不是追加）。
  const expected = templateText.replace(`# ${KEY}=\n`, [...NOTE_LINES, `${KEY}=${EXPECTED_VALUE}`, ""].join("\n"));
  expect(await readFile(envFile, "utf8")).toBe(expected);
  // 权限保持原样：mktemp 建出来是 0600，不能把部署方的 .env 权限悄悄改掉。
  expect((await stat(envFile)).mode & 0o777).toBe(0o640);
});

test("重复执行是空操作：值不变、文件字节不变、无输出", async () => {
  const envFile = await writeEnv(templateText);
  await runEnsure(envFile, FAKE_HOSTNAME);
  const first = await readFile(envFile, "utf8");

  const again = await runEnsure(envFile, FAKE_HOSTNAME);
  expect(again).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  expect(await readFile(envFile, "utf8")).toBe(first);
});

test("已有值一律不动（含部署方手填的邮箱）", async () => {
  const envFile = await writeEnv(`${KEY}=ops@corp.example\nRCS_API_KEYS=abc\n`);

  const result = await runEnsure(envFile, FAKE_HOSTNAME);
  expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  expect(await readFile(envFile, "utf8")).toBe(`${KEY}=ops@corp.example\nRCS_API_KEYS=abc\n`);
});

test("自定义 env 文件里没有该键的注释行时：追加到末尾，不动既有内容", async () => {
  const envFile = await writeEnv("RCS_API_KEYS=abc\n");

  const result = await runEnsure(envFile, FAKE_HOSTNAME);
  expect(result.exitCode).toBe(0);

  const text = await readFile(envFile, "utf8");
  expect(text.startsWith("RCS_API_KEYS=abc\n\n")).toBe(true);
  expect(text.trimEnd().split("\n").slice(-3)).toEqual([...NOTE_LINES, `${KEY}=${EXPECTED_VALUE}`]);
});

test("主机名取不到时退化为不带主机名后缀的值", async () => {
  const envFile = await writeEnv(templateText);

  const result = await runEnsure(envFile, null);
  expect(result.exitCode).toBe(0);

  const text = await readFile(envFile, "utf8");
  expect(text).toContain(`${KEY}=workflow-v2-platform@example.com\n`);
  expect(text).toMatch(new RegExp(`^${KEY}=${GENERATED_VALUE.source}$`, "m"));
});

test("主服务 env 模板保留该键的注释行，并在注里写明部署期的生成行为", () => {
  // 「就地激活」分支的前提是模板里那行注释存在；注文案是部署方读到的说明，变更时这条会一起被审。
  expect(templateText.split("\n")).toContain(`# ${KEY}=`);
  expect(templateText).toContain(`${KEY}｜必填`);
  expect(templateText).toContain("按主机名生成并固化");
});
