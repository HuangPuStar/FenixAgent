/**
 * `docker/workflow/` 的自包含性契约：干净机器上 `up -d` 一次起全栈，不 clone 上游源码、不手工 export 变量。
 *
 * 为什么要测：这三条都靠「编排里现在恰好这么写」维持，人很难在 review 时发现回退——`WORKFLOW_STUDIO_DIR`
 * 那种仓库外变量一旦溜回来，目标机就会在 `config` 阶段直接失败；bind 挂载指向交付面之外时，
 * 把目录整体拷到目标机就不再等价；而 `${VAR:?}` 的键没写进 `.env.example` 时，compose 只能靠调用方 export。
 * 判定对象是交付面文件本身（compose 与两个初始化脚本），不看 README 的说明文字。
 */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const WORKFLOW_DIRECTORY = join(REPOSITORY_ROOT, "docker/workflow");
const COMPOSE_PATH = join(WORKFLOW_DIRECTORY, "docker-compose.yml");

const composeText = await readFile(COMPOSE_PATH, "utf8");
const envTemplate = await readFile(join(WORKFLOW_DIRECTORY, ".env.example"), "utf8");

/** 按顶层 `  <name>:` 切出各服务块：只够本文件用，不追求通用 YAML 解析。 */
function serviceBlocks(): Map<string, string> {
  const blocks = new Map<string, string>();
  const matched = [...composeText.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)];
  matched.forEach((entry, index) => {
    const start = entry.index ?? 0;
    const end = index + 1 < matched.length ? (matched[index + 1]?.index ?? composeText.length) : composeText.length;
    blocks.set(entry[1] ?? "", composeText.slice(start, end));
  });
  expect(blocks.size).toBeGreaterThan(0);
  return blocks;
}

// 交付面不得再出现上游源码目录变量：它既会让 `config` 在没有该目录的机器上失败，也意味着重新引入了 clone 上游这一步。
test("compose 与初始化脚本不引用上游源码目录变量", async () => {
  const files = ["docker-compose.yml", "init-mysql.sh", "init-s3.sh", ".env.example"];
  for (const file of files) {
    const text = file === "docker-compose.yml" ? composeText : await readFile(join(WORKFLOW_DIRECTORY, file), "utf8");
    expect({ file, hasUpstreamDirVar: /\$\{?WORKFLOW_STUDIO_DIR/.test(text) }).toEqual({
      file,
      hasUpstreamDirVar: false,
    });
  }
});

// 挂载一律用本目录相对路径，且只允许落在交付面内：assets/ 与 data/ 是运行期生成的，其余是随目录交付的文件。
// 出现绝对路径 / `..` / 仓库根相对路径时，「把 docker/workflow/ 拷到目标机」就不再等价。
test("compose 的 bind 挂载只使用本目录内的相对路径", async () => {
  const sources = [...composeText.matchAll(/^\s*(?:-\s+|source:\s*)(\.{1,2}\/[^\s:]+|\.\.\/[^\s:]*)/gm)].map(
    (match) => match[1] ?? "",
  );
  expect(sources.length).toBeGreaterThan(0);

  const allowed = /^\.\/(assets(\/|$)|data\/|init-mysql\.sh$|init-s3\.sh$|nginx\.conf$|\.env$)/;
  const offenders = sources.filter((source) => !allowed.test(source));
  expect(offenders).toEqual([]);
  // 挂载源里出现仓库根相对路径（不带 `./` 前缀）同样是越界：这里显式兜住 `- docker/...` 这类写法。
  expect(composeText).not.toMatch(/^\s*(?:-\s+|source:\s*)docker\//m);
});

// `${VAR:?}` 是 compose 的必填插值：它必须有默认值之外的来源，也就是 `.env.example` 里的**有效赋值行**——
// 写成注释行等于没提供，目标机会在 `config` 阶段报缺变量。
test("compose 的必填插值键在 .env.example 里是有效赋值行", () => {
  const required = [...composeText.matchAll(/\$\{([A-Z_][A-Z0-9_]*):\?/g)].map((match) => match[1] ?? "");
  expect(required.length).toBeGreaterThan(0);

  const activeKeys = new Set(
    envTemplate
      .split("\n")
      .map((line) => /^([A-Z_][A-Z0-9_]*)=/.exec(line)?.[1])
      .filter((key): key is string => key !== undefined),
  );
  const missing = required.filter((key) => !activeKeys.has(key));
  expect(missing).toEqual([]);
});

// 资产由 assets-init 展开到宿主后才可挂载：直接挂 ./assets/ 的服务必须（直接或沿 depends_on 链）等它成功退出，
// 否则首次启动会撞上 `create_host_path: false` 报错或读到半份资产。
test("挂载 ./assets/ 的服务都依赖 assets-init 成功退出", () => {
  const blocks = serviceBlocks();
  const dependenciesOf = (name: string): string[] => {
    const dependsOn = /^ {4}depends_on:\n((?: {6}.*\n| {8}.*\n)+)/m.exec(blocks.get(name) ?? "")?.[1] ?? "";
    return [...dependsOn.matchAll(/^ {6}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1] ?? "");
  };
  const reachesAssetsInit = (name: string, seen = new Set<string>()): boolean => {
    if (seen.has(name)) return false;
    seen.add(name);
    return dependenciesOf(name).some((dependency) =>
      dependency === "assets-init" ? true : reachesAssetsInit(dependency, seen),
    );
  };

  const consumers = [...blocks.entries()]
    .filter(([, block]) => /^\s*-\s*(?:\.\/assets\/|type:\s*bind)/m.test(block) && /\.\/assets\//.test(block))
    .map(([name]) => name);
  expect(consumers.length).toBeGreaterThan(0);
  const offenders = consumers.filter((name) => !reachesAssetsInit(name));
  expect(offenders).toEqual([]);
});
