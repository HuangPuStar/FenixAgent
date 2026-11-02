/**
 * `deploy.sh validate` 的 env_file 契约：必填插值值可以来自 `deploy.env`，但 Compose 启动时仍会读取
 * 各项目自己的 `env_file`。文件缺失时 `docker compose config` 会失败，`validate` 不能只看值就报通过。
 *
 * 回归场景：`docker/otel-collector/.env` 不存在、`OO_*` 值全在 `deploy.env` —— 旧实现打印“必填项校验通过”。
 * 同时覆盖主服务 `env_file: required: false`：主服务 `.env` 缺失不应被误报。
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const DEPLOY_SCRIPT = join(REPOSITORY_ROOT, "docker/deploy.sh");
const CONFIG_LIB = join(REPOSITORY_ROOT, "docker/lib/config.sh");

const tempRoot = await mkdtemp(join(tmpdir(), "deploy-validate-env-files-"));
afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

/** compose 的必填插值片段；拆成两段，避免 linter 把测试字符串当成模板占位符。 */
const REQUIRED_VALUE_PLACEHOLDER = "$" + "{REQUIRED_VALUE:?set REQUIRED_VALUE}";

interface ValidateResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** 建一个最小交付面并跑真实 `validate`；`withCollectorEnv` 控制依赖 `.env` 是否存在。 */
async function runValidate(withCollectorEnv: boolean, withImageTag = true): Promise<ValidateResult> {
  const delivery = join(tempRoot, withCollectorEnv ? "with-env" : "without-env");
  const dockerDir = join(delivery, "docker");
  const collectorDir = join(dockerDir, "otel-collector");
  const bin = join(delivery, "bin");
  mkdirSync(join(dockerDir, "lib"), { recursive: true });
  mkdirSync(join(dockerDir, "main"), { recursive: true });
  mkdirSync(collectorDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(dockerDir, "deploy.sh"), readFileSync(DEPLOY_SCRIPT), { mode: 0o755 });
  writeFileSync(join(dockerDir, "lib/config.sh"), readFileSync(CONFIG_LIB));

  // 主服务 env_file 显式 required: false：缺失时 validate 必须放行（不能把维修/应急场景误拦）。
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
  // 依赖使用最常见的 `- .env` 写法；REQUIRED_VALUE 由 deploy.env 提供，确保失败只来自文件缺失。
  writeFileSync(
    join(collectorDir, "docker-compose.yml"),
    [
      "services:",
      "  otel-collector:",
      "    image: scratch",
      "    env_file:",
      "      - .env",
      "    environment:",
      `      REQUIRED_VALUE: ${REQUIRED_VALUE_PLACEHOLDER}`,
      "",
    ].join("\n"),
  );
  const config = ["FENIX_FEATURE_OTEL_COLLECTOR=true", "REQUIRED_VALUE=from-deploy-env"];
  if (withImageTag) config.push("RCS_IMAGE_TAG=sha-test");
  config.push("");
  writeFileSync(join(dockerDir, "deploy.env"), config.join("\n"));
  if (withCollectorEnv) writeFileSync(join(collectorDir, ".env"), "");

  // validate 只需要 docker 命令存在；用垫片避免测试依赖本机 Docker。
  writeFileSync(
    join(bin, "docker"),
    ["#!/usr/bin/env bash", 'case "$*" in', '  "compose version --short") echo 2.20.0 ;;', "esac", "exit 0", ""].join(
      "\n",
    ),
    { mode: 0o755 },
  );

  const child = Bun.spawn(["bash", join(dockerDir, "deploy.sh"), "validate"], {
    cwd: delivery,
    env: {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: process.env.HOME ?? tempRoot,
      LC_ALL: "C",
    },
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

// 依赖 .env 缺失时必须在启动前报错，即使所有必填值都已经在 deploy.env 里。
test("启用依赖的 env_file 缺失时 validate 失败并点名文件", async () => {
  const result = await runValidate(false);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("env_file docker/otel-collector/.env");
  expect(result.stderr).toContain("文件不存在");
  expect(result.stdout).not.toContain("必填项校验通过");
  // 主服务是 required: false，不能把 docker/main/.env 也报成缺失。
  expect(result.stderr).not.toContain("env_file docker/main/.env");
});

// 补齐依赖 .env 后同一份配置必须通过，确认检查的是文件存在性而不是永远报错。
test("补齐依赖 env_file 后 validate 通过", async () => {
  const result = await runValidate(true);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("必填项校验通过（主服务 + 已启用依赖）");
  expect(result.stderr).not.toContain("文件不存在");
});

// 发布 tag 必须显式提供：compose 缺省值只服务 down/ps，validate 不能让它静默通过。
test("缺少 RCS_IMAGE_TAG 时 validate 失败", async () => {
  const result = await runValidate(true, false);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("RCS_IMAGE_TAG");
  expect(result.stdout).not.toContain("必填项校验通过");
});
