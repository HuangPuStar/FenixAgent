/**
 * `docker/deploy.sh down` 的停止顺序契约（R02）：应用 → 普通依赖（启动逆序）→ 等待 5s →
 * `otel-collector` → `openobserve` → 主项目网络；升级路径只重建 rcs，不显式停观测依赖。
 *
 * 观测顺序不能取自 `discover_deps` 的目录遍历：字典序里 `openobserve` 在 `otel-collector` 之前，
 * 靠遍历会先停 OO，Collector 的最后一批队列就无处可送。测试把脚本与最小编排复制到临时交付面，
 * 用假 `docker`/`sleep` 记录真实调用顺序；不碰本机容器，也不依赖仓库工作区状态。
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const DEPLOY_SCRIPT = join(REPOSITORY_ROOT, "docker/deploy.sh");
const CONFIG_LIB = join(REPOSITORY_ROOT, "docker/lib/config.sh");

const tempRoot = await mkdtemp(join(tmpdir(), "deploy-down-order-"));
afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

let scenario = 0;

interface ScriptResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly calls: string;
}

/** 在临时交付面跑一次真实命令；只有 `docker` 与 `sleep` 被替换成记录器。 */
async function runCommand(
  command: "down" | "deploy",
  features: Readonly<Record<string, boolean>>,
): Promise<ScriptResult> {
  const delivery = join(tempRoot, `scenario-${scenario++}`);
  const dockerDir = join(delivery, "docker");
  mkdirSync(join(dockerDir, "lib"), { recursive: true });
  writeFileSync(join(dockerDir, "deploy.sh"), readFileSync(DEPLOY_SCRIPT), { mode: 0o755 });
  writeFileSync(join(dockerDir, "lib/config.sh"), readFileSync(CONFIG_LIB));
  writeFileSync(
    join(dockerDir, "deploy.env"),
    `${Object.entries(features)
      .map(([name, enabled]) => `FENIX_FEATURE_${name}=${enabled}`)
      .join("\n")}\nRCS_IMAGE_TAG=sha-test\n`,
  );
  // 主服务编排只需让脚本的前置检查找到文件；down 不解析服务定义。
  // env_file required: false 同时验证「主服务 .env 缺失不算错误」。
  mkdirSync(join(dockerDir, "main"), { recursive: true });
  writeFileSync(
    join(dockerDir, "main/docker-compose.yml"),
    [
      "name: fenix",
      "services:",
      "  rcs:",
      "    image: scratch",
      "    env_file:",
      "      - path: .env",
      "        required: false",
      "",
    ].join("\n"),
  );
  // 普通依赖用 alpha / zulu 验证逆序；观测依赖目录存在即可被 feature 开关选中。
  for (const name of ["alpha", "zulu", "otel-collector", "openobserve"]) {
    mkdirSync(join(dockerDir, name), { recursive: true });
    writeFileSync(join(dockerDir, name, "docker-compose.yml"), "services: {}\n");
  }

  const bin = join(delivery, "bin");
  const callsPath = join(delivery, "calls.log");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "docker"),
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$*" >> "$FAKE_CALLS"',
      'case "$*" in',
      '  "compose version --short") echo 2.20.0 ;;',
      '  *" ps -q rcs") echo fake-rcs-container ;;',
      '  "inspect -f {{.State.ExitCode}} fake-rcs-container") echo 0 ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "sleep"),
    ["#!/usr/bin/env bash", 'printf "sleep %s\\n" "$*" >> "$FAKE_CALLS"', "exit 0", ""].join("\n"),
    { mode: 0o755 },
  );

  const child = Bun.spawn(["bash", join(dockerDir, "deploy.sh"), command], {
    cwd: delivery,
    // 只给最小环境：宿主 shell 里残留的 FENIX_FEATURE_* 不能影响断言。
    env: {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: process.env.HOME ?? tempRoot,
      FAKE_CALLS: callsPath,
      LC_ALL: "C",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { exitCode, stderr, calls: existsSync(callsPath) ? readFileSync(callsPath, "utf8") : "" };
}

/** 调用行在日志中的位置（按行尾匹配，避免 `up -d` 命中 `up -d postgres`）；缺失返回 -1。 */
function position(calls: string, needle: string): number {
  return calls.split("\n").findIndex((line) => line.endsWith(needle));
}

/** 断言这些调用都出现，且严格按给定顺序执行。 */
function expectOrder(calls: string, needles: readonly string[]): void {
  const positions = needles.map((needle) => ({ needle, at: position(calls, needle) }));
  expect(positions.filter((item) => item.at < 0)).toEqual([]);
  for (let index = 1; index < positions.length; index++) {
    expect(positions[index]?.at).toBeGreaterThan(positions[index - 1]?.at ?? -1);
  }
}

// 观测依赖必须按数据流反向停：先 Collector（冲刷队列），最后 OO；普通依赖仍保持启动逆序。
test("down 依次停应用、普通依赖逆序、等待、Collector、OO、主项目网络", async () => {
  const result = await runCommand("down", { ALPHA: true, ZULU: true, OTEL_COLLECTOR: true, OPENOBSERVE: true });

  expect(result.exitCode).toBe(0);
  expect(result.stderr).not.toContain("[deploy] 错误");
  expectOrder(result.calls, [
    " --profile redis stop rcs",
    "/zulu/docker-compose.yml down",
    "/alpha/docker-compose.yml down",
    "sleep 5",
    "/otel-collector/docker-compose.yml down",
    "/openobserve/docker-compose.yml down",
    "/main/docker-compose.yml --profile redis down",
  ]);
});

// feature 开关仍然生效：只启用 Collector 时只停 Collector，不误停 OO。
test("只启用 Collector 时只停 Collector", async () => {
  const result = await runCommand("down", { OTEL_COLLECTOR: true, OPENOBSERVE: false });

  expect(result.exitCode).toBe(0);
  expect(position(result.calls, "/otel-collector/docker-compose.yml down")).toBeGreaterThan(-1);
  expect(position(result.calls, "/openobserve/docker-compose.yml down")).toBe(-1);
  expect(position(result.calls, "sleep 5")).toBeGreaterThan(-1);
});

// 只启用 OO 时没有 Collector 可等：仍只停 OO，且不需要额外的批量导出窗口。
test("只启用 OO 时只停 OO 且不等待", async () => {
  const result = await runCommand("down", { OTEL_COLLECTOR: false, OPENOBSERVE: true });

  expect(result.exitCode).toBe(0);
  expect(position(result.calls, "/otel-collector/docker-compose.yml down")).toBe(-1);
  expect(position(result.calls, "/openobserve/docker-compose.yml down")).toBeGreaterThan(-1);
  expect(position(result.calls, "sleep 5")).toBe(-1);
});

// 两个观测开关都关闭时不产生任何观测停止或等待，避免把普通 down 拖慢。
test("观测开关全关时不停观测依赖也不等待", async () => {
  const result = await runCommand("down", { OTEL_COLLECTOR: false, OPENOBSERVE: false });

  expect(result.exitCode).toBe(0);
  expect(position(result.calls, "/otel-collector/docker-compose.yml down")).toBe(-1);
  expect(position(result.calls, "/openobserve/docker-compose.yml down")).toBe(-1);
  expect(position(result.calls, "sleep 5")).toBe(-1);
});

// 首次 up 必须先创建共享网络并起观测出口，再起 rcs：应用首批遥测才有接收端，且不依赖跨项目 depends_on。
test("up 先起 postgres 建网、再起 OO/Collector、最后起 rcs 与普通依赖", async () => {
  const result = await runCommand("up", { ALPHA: true, ZULU: true, OTEL_COLLECTOR: true, OPENOBSERVE: true });

  expect(result.exitCode).toBe(0);
  expect(result.stderr).not.toContain("[deploy] 错误");
  expectOrder(result.calls, [
    "/main/docker-compose.yml up -d postgres",
    "/openobserve/docker-compose.yml up -d",
    "/otel-collector/docker-compose.yml up -d",
    "/main/docker-compose.yml up -d",
    "/alpha/docker-compose.yml up -d",
    "/zulu/docker-compose.yml up -d",
  ]);
});

// 升级路径不显式停观测依赖：旧 rcs 由 compose up -d 按 stop_grace_period 重建，Collector/OO 全程可用。
test("deploy 升级路径不显式停观测依赖，只重建 rcs 并保持依赖启动", async () => {
  const result = await runCommand("deploy", { OTEL_COLLECTOR: true, OPENOBSERVE: true });

  expect(result.exitCode).toBe(0);
  expect(result.stderr).not.toContain("[deploy] 错误");
  expect(position(result.calls, " --profile redis stop rcs")).toBe(-1);
  expect(position(result.calls, "/otel-collector/docker-compose.yml down")).toBe(-1);
  expect(position(result.calls, "/openobserve/docker-compose.yml down")).toBe(-1);
  expect(position(result.calls, "/main/docker-compose.yml up -d")).toBeGreaterThan(-1);
  expect(position(result.calls, "/otel-collector/docker-compose.yml up -d")).toBeGreaterThan(-1);
  expect(position(result.calls, "/openobserve/docker-compose.yml up -d")).toBeGreaterThan(-1);
});
