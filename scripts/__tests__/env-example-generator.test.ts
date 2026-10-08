import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEnvExamples, collectEnvEntries, findEnvExampleDrift, generateEnvExamples } from "../generate-env-example";

const tempRoot = await mkdtemp(join(tmpdir(), "env-example-"));
afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

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

// 三份模板必须覆盖声明面的每一个键：缺一个键，该旋钮在部署时就只能靠代码默认值（A4 的缺口就是 25 / 33 个键）。
// 这条同时兜住宿主说明表的同步——env.ts 新增键而没补说明时，collectEnvEntries() 会直接抛错。
test("三份模板覆盖宿主与全部模块声明的键", async () => {
  const declared = collectEnvEntries().map((entry) => entry.key);
  const templates = await generatedTemplates();

  expect([...templates.keys()]).toEqual(["deploy/env/rcs.example", ".env.example", "docker/prod/.env.example"]);
  for (const [path, template] of templates) {
    expect({ path, missing: declared.filter((key) => !template.keys.has(key)) }).toEqual({ path, missing: [] });
  }
});

// 两条渲染不变量：键行恒为注释行（复制模板不隐式生效取值），密钥键恒为空值（连样例都不写）。
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
      expect({ path, key, assignments }).toEqual({ path, key, assignments: [`# ${key}=`] });
    }
  }
});

// 场景差异机制必须是活的：真相来源不带任何场景注记，开发模板对应开发起点，生产模板对应编排必填清单。
test("真相来源不带场景注记，两份薄文件各自保留场景差异", async () => {
  const templates = await generatedTemplates();
  const main = templates.get("deploy/env/rcs.example")?.text ?? "";
  const dev = templates.get(".env.example")?.text ?? "";
  const prod = templates.get("docker/prod/.env.example")?.text ?? "";

  expect(main).not.toContain("注：");
  expect(dev).toContain("cp .env.example .env");
  expect(dev).toContain("#   注：本地开发");
  expect(dev).not.toContain("AGENT_SITES_MASTER_KEY（站点托管）");
  expect(prod).toContain("docker compose --env-file docker/prod/.env");
  expect(prod).toContain("OPENAI_API_KEY（Agent 智能生成）");
  expect(prod).not.toContain("#   注：本地开发");
});

// 场景补充键（声明面之外、但确有消费方的键）必须真的落进模板，不能只写在生成器里。
test("声明面之外的键带消费方落在两份薄文件里", async () => {
  const templates = await generatedTemplates();
  const dev = templates.get(".env.example")?.text ?? "";
  const prod = templates.get("docker/prod/.env.example")?.text ?? "";

  for (const key of ["LOG_LEVEL", "LOG_FORMAT", "LOG_DIR", "LOG_RETENTION_DAYS"]) {
    expect({ key, inDev: dev.includes(`# ${key}=`), inProd: prod.includes(`# ${key}=`) }).toEqual({
      key,
      inDev: true,
      inProd: true,
    });
  }
  expect(dev).toContain("消费方：packages/acp-runtime-cli");
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

// 门禁必须真的以退出码表达结论：一致 0、漂移 1（CI 步骤读的是退出码，不是日志文本）。
test("门禁退出码：一致返回 0，漂移返回 1", async () => {
  await generateEnvExamples({ repositoryRoot: tempRoot });
  expect(await checkEnvExamples({ repositoryRoot: tempRoot })).toBe(0);

  await writeFile(join(tempRoot, "docker/prod/.env.example"), "", "utf8");
  const originalError = console.error;
  console.error = () => {};
  try {
    expect(await checkEnvExamples({ repositoryRoot: tempRoot })).toBe(1);
  } finally {
    console.error = originalError;
  }
});
