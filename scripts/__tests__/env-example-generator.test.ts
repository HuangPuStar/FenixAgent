import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkEnvExamples,
  collectComposeKeys,
  collectEnvEntries,
  findEnvExampleDrift,
  generateEnvExamples,
} from "../generate-env-example";
import { COMMON_FEATURE_SWITCHES, ENV_TEMPLATES } from "../lib/env-example-spec";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const tempRoot = await mkdtemp(join(tmpdir(), "env-example-"));
afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

/** 部署面模板：渲染 docker/deploy.sh 的开关与编排插值键，不覆盖应用声明面（覆盖断言只对应用面模板成立）。 */
const DEPLOY_TEMPLATE_PATH = "docker/deploy.env.example";
const APP_TEMPLATE_PATHS = ENV_TEMPLATES.filter((template) => template.surface !== "deploy").map(
  (template) => template.path,
);

/** 生成物里的键集合：只认注释行形式的赋值（`# KEY=…`），有效行一旦出现就是渲染不变量被破坏。 */
function readTemplate(text: string): { keys: Set<string>; lines: string[] } {
  const lines = text.split("\n");
  const keys = new Set<string>();
  for (const line of lines) {
    const matched = /^#\s*([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (matched?.[1] !== undefined) keys.add(matched[1]);
  }
  return { keys, lines };
}

/** 生成三份模板到临时目录并读回文本；真实文件不参与测试，避免测试与 `--check` 互相干扰。 */
async function generatedTemplates(): Promise<Map<string, { keys: Set<string>; lines: string[]; text: string }>> {
  const paths = await generateEnvExamples({ repositoryRoot: tempRoot });
  const result = new Map<string, { keys: Set<string>; lines: string[]; text: string }>();
  for (const path of paths) {
    const text = await readFile(join(tempRoot, path), "utf8");
    result.set(path, { ...readTemplate(text), text });
  }
  return result;
}

// 两份应用面模板必须覆盖声明面的每一个键：缺一个键，该旋钮在部署时就只能靠代码默认值（A4 的缺口就是 25 / 33 个键）。
// 这条同时兜住宿主说明表的同步——env.ts 新增键而没补说明时，collectEnvEntries() 会直接抛错。
test("两份应用面模板覆盖宿主与全部模块声明的键", async () => {
  const declared = collectEnvEntries().map((entry) => entry.key);
  const templates = await generatedTemplates();

  expect([...templates.keys()]).toEqual(["deploy/env/rcs.example", ".env.example", DEPLOY_TEMPLATE_PATH]);
  for (const path of APP_TEMPLATE_PATHS) {
    const template = templates.get(path);
    expect({ path, missing: declared.filter((key) => !template?.keys.has(key)) }).toEqual({ path, missing: [] });
  }
});

// 两条渲染不变量：键行恒为注释行（复制模板不隐式生效取值），密钥键恒为空值（连样例都不写）。
// 部署面模板只覆盖编排插值到的键，因此密钥断言对它是「列出即必须为空值」，覆盖率由应用面模板的用例保证。
test("模板中所有键行都是注释行，且密钥键不写任何取值", async () => {
  const secrets = new Set(
    collectEnvEntries()
      .filter((entry) => entry.secret)
      .map((entry) => entry.key),
  );
  expect(secrets.size).toBeGreaterThan(0);

  for (const [path, template] of await generatedTemplates()) {
    const active = template.lines.filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line));
    expect({ path, active }).toEqual({ path, active: [] });

    for (const key of secrets) {
      const assignments = template.lines.filter((line) => line.startsWith(`# ${key}=`));
      if (!APP_TEMPLATE_PATHS.includes(path) && assignments.length === 0) continue;
      expect({ path, key, assignments }).toEqual({ path, key, assignments: [`# ${key}=`] });
    }
  }
});

// 场景差异机制必须是活的：真相来源不带任何场景注记，开发模板对应开发起点，部署模板对应开关与各键的去处。
test("真相来源不带场景注记，另两份产出各自保留场景差异", async () => {
  const templates = await generatedTemplates();
  const main = templates.get("deploy/env/rcs.example")?.text ?? "";
  const dev = templates.get(".env.example")?.text ?? "";
  const deploy = templates.get(DEPLOY_TEMPLATE_PATH)?.text ?? "";

  expect(main).not.toContain("注：");
  expect(main).toContain("docker/deploy.env.example 渲染的是另一个面");
  expect(dev).toContain("cp .env.example .env");
  expect(dev).toContain("#   注：本地开发");
  expect(dev).not.toContain("FENIX_FEATURE_");
  expect(deploy).toContain("./docker/deploy.sh init");
  expect(deploy).toContain("# FENIX_FEATURE_");
  expect(deploy).toContain("由仓库根 .env 提供");
  expect(deploy).not.toContain("#   注：本地开发");
});

// 场景补充键（声明面之外、但确有消费方的键）必须真的落进模板，不能只写在生成器里。
test("声明面之外的键带消费方落在两份薄文件里", async () => {
  const templates = await generatedTemplates();
  const dev = templates.get(".env.example")?.text ?? "";
  const deploy = templates.get(DEPLOY_TEMPLATE_PATH)?.text ?? "";

  for (const key of ["LOG_LEVEL", "LOG_FORMAT", "LOG_DIR", "LOG_RETENTION_DAYS"]) {
    expect({ key, inDev: dev.includes(`# ${key}=`) }).toEqual({ key, inDev: true });
  }
  expect(dev).toContain("消费方：packages/acp-runtime-cli");
  // 基础服务凭据的消费方是编排，键落在仓库根 .env：开发模板要说清这一点。
  for (const key of ["POSTGRES_PASSWORD", "RUSTFS_ACCESS_KEY", "RUSTFS_SECRET_KEY"]) {
    expect({ key, inDev: dev.includes(`# ${key}=`) }).toEqual({ key, inDev: true });
  }
  expect(dev).toContain("消费方：docker/common/docker-compose.yml");

  // 部署模板只列键与去处：由仓库根 .env 提供的键不写取值（模板受版本控制）。
  expect(deploy).toContain("# POSTGRES_PASSWORD=");
  expect(deploy).toContain("# RUSTFS_SECRET_KEY=");
  expect(deploy.split("\n").filter((line) => line.startsWith("# POSTGRES_PASSWORD=")).length).toBe(1);
});

// 漂移门禁的三种判定：逐字节一致 → 静默；内容被手改 → 指向首个差异行；文件缺失 → 明确报缺失。
// 三份模板都是生成物，任何一种漂移都不能靠「测试自己生成的产物」蒙混过去。
test("漂移门禁对一致、被改动、缺失三种情形给出不同判定", async () => {
  await generateEnvExamples({ repositoryRoot: tempRoot });
  expect(await findEnvExampleDrift({ repositoryRoot: tempRoot })).toEqual([]);

  await writeFile(join(tempRoot, ".env.example"), "# 手改\n", "utf8");
  const drifted = await findEnvExampleDrift({ repositoryRoot: tempRoot });
  expect(drifted.map((item) => item.path)).toEqual([".env.example"]);
  expect(drifted[0]?.detail).toContain("首个差异在第 1 行");

  await rm(join(tempRoot, "deploy/env/rcs.example"));
  const missing = await findEnvExampleDrift({ repositoryRoot: tempRoot });
  expect(missing.map((item) => item.path).sort()).toEqual([".env.example", "deploy/env/rcs.example"]);
  expect(missing.find((item) => item.path === "deploy/env/rcs.example")?.detail).toContain("模板不存在");
});

// 编排插值的三种写法都要认出来，注释行里的插值只是说明文字（顶层 compose 就用注释记录了「不要用 ${DATABASE_URL}」）。
// 夹具里的 `$\{...}` 是模板字面量转义：写成普通字符串会被 noTemplateCurlyInString 当成遗留占位符。
test("编排插值解析认三种写法，且跳过注释行", () => {
  const keys = collectComposeKeys(
    [
      "ports:",
      `    - "$\{FENIX_HTTP_PORT:-3001}:3000"`,
      `    - $\{POSTGRES_PORT-5432}:5432`,
      "environment:",
      `    # 不要写成 $\{DATABASE_URL}，会被宿主值污染`,
      `    RCS_API_KEYS: $\{RCS_API_KEYS:?请在仓库根 .env 配置}`,
      `    OPTIONAL: $\{SOME_OPTIONAL_KEY}`,
    ].join("\n"),
  );

  expect([...keys.entries()].sort(([left], [right]) => left.localeCompare(right))).toEqual([
    ["FENIX_HTTP_PORT", { required: false, defaultValue: "3001" }],
    ["POSTGRES_PORT", { required: false, defaultValue: "5432" }],
    ["RCS_API_KEYS", { required: true, defaultValue: undefined }],
    ["SOME_OPTIONAL_KEY", { required: false, defaultValue: undefined }],
  ]);
});

// 部署模板的开关必须与脚本同源：docker/ 下每个带 docker-compose.yml 的目录都有一行开关（与 discover_deps 同规则），
// common 的开关表则是 deploy.sh 里 COMMON_OPTIONAL_FEATURES 的镜像——脚本加了服务而模板没跟上，用户就看不到开关。
test("部署模板为每个依赖目录渲染开关，并与 deploy.sh 的 common 开关表一致", async () => {
  await generateEnvExamples({ repositoryRoot: tempRoot });
  const deployText = await readFile(join(tempRoot, DEPLOY_TEMPLATE_PATH), "utf8");

  const dockerRoot = join(REPOSITORY_ROOT, "docker");
  const dirs = (await readdir(dockerRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== "common")
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(dockerRoot, name, "docker-compose.yml")));
  expect(dirs.length).toBeGreaterThan(0);
  for (const dir of dirs) {
    const key = `FENIX_FEATURE_${dir.toUpperCase().replaceAll("-", "_")}`;
    expect({ dir, rendered: deployText.includes(`# ${key}=false`) }).toEqual({ dir, rendered: true });
  }

  const script = await readFile(join(REPOSITORY_ROOT, "docker/deploy.sh"), "utf8");
  const declared = /COMMON_OPTIONAL_FEATURES="([^"]*)"/.exec(script)?.[1] ?? "";
  const names = declared.split(/\s+/).filter((name) => name.length > 0);
  expect(names).toEqual(COMMON_FEATURE_SWITCHES.map((item) => item.name));
  for (const name of names) expect(deployText).toContain(`# FENIX_FEATURE_${name}=false`);
});

// 门禁必须真的以退出码表达结论：一致 0、漂移 1（CI 步骤读的是退出码，不是日志文本）。
test("门禁退出码：一致返回 0，漂移返回 1", async () => {
  await generateEnvExamples({ repositoryRoot: tempRoot });
  expect(await checkEnvExamples({ repositoryRoot: tempRoot })).toBe(0);

  await writeFile(join(tempRoot, DEPLOY_TEMPLATE_PATH), "", "utf8");
  const originalError = console.error;
  console.error = () => {};
  try {
    expect(await checkEnvExamples({ repositoryRoot: tempRoot })).toBe(1);
  } finally {
    console.error = originalError;
  }
});
