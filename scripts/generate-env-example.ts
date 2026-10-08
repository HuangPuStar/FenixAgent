/**
 * 部署环境变量模板生成器与漂移门禁。
 *
 * **为什么模板改成生成物**：`deploy/env/*.example` 是部署模板的真相来源（backend-development §5.4），但本条目
 * 开工时仓库里没有 `deploy/env/`；唯一的历史模板（根 `.env.example`）相对声明面已整体
 * 过期——`SKILL_DIR`、`WORKSPACE_ROOT`、`YJS_MAX_CLIENTS`、`LANGFUSE_*`、`HERMES_*`、`GOTENBERG_URL`、
 * `ACPX_G_URL`、`PLUGIN_MARKET_REGISTRY_*` 在任何受版本控制的模板里都查不到，缺一个键就意味着该旋钮在部署时
 * 只能靠代码默认值。手写补全会继续漂移，所以三份模板都改为同一次渲染的产物，由 `--check` 按字节守住。
 *
 * **覆盖面** = 宿主 `apps/server/src/env.ts` 的自有键 + 生成 registry（`apps/generated/module-registry.ts`）里
 * **全部**模块的 `envDefinitions`；刻意不按 assembly profile 过滤——profile 描述运行拓扑，模板描述「这个进程能配
 * 哪些旋钮」，按 profile 过滤会让「换个 profile 才用到的键」永久没有落点。
 *
 * **两份应用面产出 + 一份部署面产出**：`deploy/env/rcs.example` 是应用声明面的真相来源（只含声明面全量键）；
 * 根 `.env.example` 由同一次渲染加本地开发场景差异（文件头、逐键注记、该场景确有消费方但尚未在声明面上的键）。
 * `docker/deploy.env.example` 渲染的是另一个面：`docker/deploy.sh` 的开关与编排的变量插值键（含基础服务凭据
 * 的去处），由生成器从 `docker/` 的目录与顶层 / common 编排发现，与应用声明面无键集包含关系。
 * 两条渲染不变量由 `scripts/__tests__/env-example-generator.test.ts` 守护：键行恒为注释行
 * （`HERMES_PLATFORMS` 一类键的空串与未设置语义不同，留成有效空行会改变行为）；密钥类键不写任何取值，连样例
 * 也不写。
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { EnvDefinition, ModuleManifest } from "@fenix/platform-sdk";
import { z } from "zod/v4";
import { generatedModuleManifests } from "../apps/generated/module-registry";
import { parseEnv } from "../apps/server/src/env";
import {
  COMMON_FEATURE_SWITCHES,
  DEPLOY_KEY_NOTES,
  DEPLOY_OWNER_COMMON,
  DEPLOY_OWNER_ORDER,
  DEPLOY_OWNER_ROOT_ENV,
  DEPLOY_OWNER_SWITCHES,
  ENV_TEMPLATES,
  type EnvEntry,
  type EnvTemplate,
  HOST_ENV_NOTES,
  type UndeclaredKey,
} from "./lib/env-example-spec";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
const HOST_OWNER = "宿主 apps/server/src/env.ts";
/** 宿主 schema 必填键在「探测解析」时用的占位值；仅用于让解析走通，不进入任何产出。 */
const REQUIRED_KEY_FIXTURE = "1";

/**
 * 用「逐键记录访问」的 Proxy 当解析输入，收齐 zod 对象 schema 读过的键。
 *
 * 与 `assembly-env.test.ts` 的探测手段同源：schema 对象没有导出，只能让 zod 自己把键报出来。`fill` 决定每个键
 * 探测时取到的值——传 undefined 得到「未设置」形状，传占位值让必填键走通；`has` 与 `fill` 保持一致，因为 zod 会
 * 用 `key in input` 区分「键不存在（走 default/optional）」与「键存在但值非法」，只实现 `get` 会让占位值被当成未
 * 提供。
 */
function probeHostSchema(fill: (key: string) => unknown): { keys: string[]; parsed?: unknown; error?: unknown } {
  const keys = new Set<string>();
  const probe = new Proxy({} as Record<string, unknown>, {
    get: (_target, property) => {
      if (typeof property !== "string") return;
      keys.add(property);
      return fill(property);
    },
    has: (_target, property) => typeof property === "string" && fill(property) !== undefined,
  });
  try {
    return { keys: [...keys], parsed: parseEnv(probe) };
  } catch (error) {
    return { keys: [...keys], error };
  }
}

/** 取 zod 解析失败的 issue 键名；宿主 schema 的键都是顶层字段，`path` 恒为单段。 */
function readIssueKeys(error: unknown): string[] {
  if (!(error instanceof z.ZodError)) {
    throw new Error(`宿主 env schema 解析失败但不是校验错误，无法枚举必填键：${String(error)}`);
  }
  return [...new Set(error.issues.map((issue) => String(issue.path[0])))];
}

/** 宿主键的声明条目：键集合与必填项由 schema 探测，说明与密钥标记来自 {@link HOST_ENV_NOTES}。 */
function collectHostEntries(): EnvEntry[] {
  const unset = probeHostSchema(() => undefined);
  const requiredKeys = unset.error === undefined ? [] : readIssueKeys(unset.error);

  const filled = probeHostSchema((key) => (requiredKeys.includes(key) ? REQUIRED_KEY_FIXTURE : undefined));
  if (filled.error !== undefined) {
    throw new Error(
      `宿主 env schema 的必填键无法用占位值 ${JSON.stringify(REQUIRED_KEY_FIXTURE)} 解析：` +
        `${readIssueKeys(filled.error).join("、")}；请在 REQUIRED_KEY_FIXTURE 换一个能通过校验的占位值`,
    );
  }
  // 必填键的取值来自上面的占位值，不是默认值；其余字段未设置时取到的就是代码默认值。
  const defaults = new Map(
    Object.entries(filled.parsed as Record<string, unknown>).filter(([key]) => !requiredKeys.includes(key)),
  );

  const entries = Object.keys(HOST_ENV_NOTES).map((key) => {
    const note = HOST_ENV_NOTES[key];
    const rendered = renderDefaultValue(defaults.get(key));
    return {
      key,
      owner: HOST_OWNER,
      required: requiredKeys.includes(key),
      defaultValue: rendered.text,
      multilineDefault: rendered.multiline,
      secret: note?.secret === true,
      // 宿主配置在启动期读取并固化；不逐键标注「改值需重启」，以免淹没模块侧的该标记。
      restartRequired: false,
      description: firstSentence(note?.description ?? ""),
    };
  });

  const unknown = unset.keys.filter((key) => HOST_ENV_NOTES[key] === undefined);
  if (unknown.length > 0) {
    throw new Error(`宿主 env schema 新增了未登记说明的键：${unknown.join("、")}；请在 HOST_ENV_NOTES 补一行`);
  }
  const stale = Object.keys(HOST_ENV_NOTES).filter((key) => !unset.keys.includes(key));
  if (stale.length > 0) {
    throw new Error(`HOST_ENV_NOTES 里的键已不在宿主 env schema 中：${stale.join("、")}；请从表中删除`);
  }
  return entries;
}

/** 模块键的声明条目；必填与默认值由 schema 对 undefined 的解析结果判定（loader 走的就是这条路径）。 */
function toModuleEntry(moduleId: string, definition: EnvDefinition): EnvEntry {
  const unset = definition.schema.safeParse(undefined);
  const rendered = renderDefaultValue(definition.defaultValue ?? (unset.success ? unset.data : undefined));
  return {
    key: definition.key,
    owner: `模块 ${moduleId}`,
    required: !unset.success,
    defaultValue: rendered.text,
    multilineDefault: rendered.multiline,
    secret: definition.secret,
    restartRequired: definition.restartRequired,
    description: firstSentence(definition.description),
  };
}

/** 把默认值渲染成单行文本；对象/数组用紧凑 JSON，未设置语义返回 undefined。 */
function renderDefaultValue(value: unknown): { text: string | undefined; multiline: boolean } {
  if (value === undefined) return { text: undefined, multiline: false };
  if (typeof value === "string") return { text: value, multiline: value.includes("\n") };
  if (typeof value === "number" || typeof value === "boolean") return { text: String(value), multiline: false };
  const text = JSON.stringify(value) ?? "";
  return { text, multiline: text.includes("\n") };
}

/** 一句话说明：取声明 description 的首句；整段没有句号时原样保留。 */
function firstSentence(description: string): string {
  const collapsed = description.replace(/\s+/g, " ").trim();
  const head = collapsed.split("。")[0]?.trim() ?? "";
  if (head.length === 0) return collapsed;
  return collapsed.includes("。") ? `${head}。` : head;
}

/**
 * 声明面全量键：宿主 + 全部模块。
 *
 * 同名键必须渲染出同一行内容——平台侧 `assertDefinitions()` 只比对 schema / 默认值 / secret / 重启标记，说明文案
 * 可以不一致；而模板按说明渲染，两处文案不同会让模板内容取决于模块顺序。这里按渲染输入比对并当场报错。
 *
 * 导出是给同目录用例断言「模板覆盖了声明面的每个键」用的：用例自己再探测一遍 schema 只会得到第二份真相。
 */
export function collectEnvEntries(): EnvEntry[] {
  const manifests: readonly ModuleManifest[] = generatedModuleManifests;
  const definitions = manifests.flatMap((manifest) =>
    (manifest.envDefinitions ?? []).map((definition) => toModuleEntry(manifest.id, definition)),
  );

  const byKey = new Map<string, EnvEntry>();
  for (const entry of [...collectHostEntries(), ...definitions]) {
    const existing = byKey.get(entry.key);
    if (existing === undefined) byKey.set(entry.key, entry);
    else if (JSON.stringify(existing) !== JSON.stringify(entry)) {
      throw new Error(`环境变量 ${entry.key} 被多处以不同说明/取值声明：${existing.owner} 与 ${entry.owner}`);
    }
  }
  return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key));
}

/** 部署面的发现来源：顶层与 common 两个编排文件。依赖目录的键走各自 .env，不在部署模板的范围内。 */
const DEPLOY_SURFACE_FILES = ["docker-compose.yml", "docker/common/docker-compose.yml"] as const;

/** 不参与依赖发现的目录，与 docker/deploy.sh 的 EXCLUDED_DIRS 同一规则：common 是基础服务，随顶层 include。 */
const DEPLOY_EXCLUDED_DIRS = new Set(["common"]);

/** 目录名 → 开关变量名：sandbox-peri → FENIX_FEATURE_SANDBOX_PERI（同 docker/deploy.sh 的 feature_var）。 */
function featureVarFor(name: string): string {
  return `FENIX_FEATURE_${name.toUpperCase().replaceAll("-", "_")}`;
}

/**
 * 从编排文本收集变量插值键：`${VAR}` / `${VAR:-默认}` / `${VAR:?说明}`（带不带冒号两种写法都认）。
 * 注释行不计——注释里的插值只是说明文字，不构成 compose 的取值来源。
 */
export function collectComposeKeys(text: string): Map<string, { required: boolean; defaultValue: string | undefined }> {
  const keys = new Map<string, { required: boolean; defaultValue: string | undefined }>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) continue;
    for (const match of line.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?([-?])([^}]*))?\}/g)) {
      const key = match[1] ?? "";
      const marker = match[2];
      const payload = match[3] ?? "";
      const info =
        marker === "?"
          ? { required: true, defaultValue: undefined }
          : { required: false, defaultValue: marker === "-" ? payload : undefined };
      const existing = keys.get(key);
      if (
        existing !== undefined &&
        (existing.required !== info.required || existing.defaultValue !== info.defaultValue)
      ) {
        throw new Error(`部署键 ${key} 的插值形式不一致：请把默认值与必填标记统一`);
      }
      keys.set(key, info);
    }
  }
  return keys;
}

/** docker/ 下带 docker-compose.yml 的目录（除 common），与 docker/deploy.sh 的 discover_deps 同一规则。 */
async function discoverDependencyDirs(): Promise<string[]> {
  const entries = await readdir(resolve(REPOSITORY_ROOT, "docker"), { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !DEPLOY_EXCLUDED_DIRS.has(entry.name))
    .map((entry) => entry.name);
  const withCompose: string[] = [];
  for (const dir of dirs) {
    try {
      await readFile(resolve(REPOSITORY_ROOT, "docker", dir, "docker-compose.yml"), "utf8");
      withCompose.push(dir);
    } catch {
      // 没有 docker-compose.yml 的目录不是依赖单元（如 docker/lib/ 这类配套设施），跳过。
    }
  }
  return withCompose.sort();
}

/**
 * 部署面条目：依赖开关（按目录发现）+ common 可选服务开关 + 编排插值键（归属决定它写在哪份文件里）。
 *
 * 发现始终相对仓库根——部署面就是本仓库的 docker/ 与 compose 文件，注入的 `repositoryRoot` 只影响产出写到哪。
 * 键集合两个方向都报错：编排新增键而注记表没写、注记表里的键已不在编排中，都在这里当场失败。
 */
export async function collectDeployEntries(): Promise<EnvEntry[]> {
  const composeKeys = new Map<string, { required: boolean; defaultValue: string | undefined }>();
  for (const file of DEPLOY_SURFACE_FILES) {
    const text = await readFile(resolve(REPOSITORY_ROOT, file), "utf8");
    for (const [key, info] of collectComposeKeys(text)) {
      const existing = composeKeys.get(key);
      if (
        existing !== undefined &&
        (existing.required !== info.required || existing.defaultValue !== info.defaultValue)
      ) {
        throw new Error(`部署键 ${key} 在 ${file} 里的插值形式与前面不一致：请统一默认值与必填标记`);
      }
      composeKeys.set(key, info);
    }
  }

  const unknown = [...composeKeys.keys()].filter((key) => DEPLOY_KEY_NOTES[key] === undefined);
  if (unknown.length > 0) {
    throw new Error(`编排新增了未登记归属的部署键：${unknown.join("、")}；请在 DEPLOY_KEY_NOTES 补一行`);
  }

  const entries: EnvEntry[] = [];
  const switchKeys = new Set<string>();
  for (const dir of await discoverDependencyDirs()) {
    const key = featureVarFor(dir);
    switchKeys.add(key);
    entries.push({
      key,
      owner: DEPLOY_OWNER_SWITCHES,
      required: false,
      defaultValue: "false",
      multilineDefault: false,
      secret: false,
      restartRequired: false,
      description: `启动依赖 docker/${dir}/；该目录的必填键见它的 README 与 .env.example。`,
    });
  }
  for (const item of COMMON_FEATURE_SWITCHES) {
    const key = `FENIX_FEATURE_${item.name}`;
    if (switchKeys.has(key)) {
      throw new Error(`common 的可选服务开关 ${key} 与依赖目录开关重名：两者只能有一个（改目录名或服务名）`);
    }
    entries.push({
      key,
      owner: DEPLOY_OWNER_COMMON,
      required: false,
      defaultValue: "false",
      multilineDefault: false,
      secret: false,
      restartRequired: false,
      description: item.description,
    });
  }
  for (const key of Object.keys(DEPLOY_KEY_NOTES).sort()) {
    const note = DEPLOY_KEY_NOTES[key];
    const info = composeKeys.get(key);
    if (note === undefined || info === undefined) {
      throw new Error(`部署键 ${key} 已不在顶层 / common 编排中：请从 DEPLOY_KEY_NOTES 删除`);
    }
    entries.push({
      key,
      owner: note.owner,
      required: info.required,
      defaultValue: info.defaultValue,
      multilineDefault: info.defaultValue?.includes("\n") === true,
      secret: note.secret === true,
      restartRequired: false,
      description: note.description,
      // 由仓库根 .env 提供的键在这份模板里只列键与去处：模板受版本控制，值不得抄进来。
      hideValue: note.owner === DEPLOY_OWNER_ROOT_ENV,
    });
  }
  return entries;
}

function describeDefault(entry: EnvEntry): string {
  if (entry.required) return "无默认值";
  if (entry.defaultValue === undefined) return "未设置即不生效";
  if (entry.secret) return "内置默认值（此处不展示）";
  if (entry.multilineDefault) return "默认值为多行文本";
  if (entry.defaultValue === "") return "默认空串";
  return `默认 ${entry.defaultValue}`;
}

/** 渲染单个键：元信息行 → 说明行 → 场景注记 → 注释行形式的赋值。 */
function renderEntry(entry: EnvEntry, note: string | undefined): string[] {
  const markers = [entry.required ? "必填" : "可选", describeDefault(entry)];
  if (entry.secret) markers.push("密钥");
  if (entry.restartRequired) markers.push("改值需重启");

  const lines = [`# ${entry.key}｜${markers.join("｜")}`, `#   ${entry.description}`];
  if (note !== undefined) lines.push(`#   注：${note}`);
  // 密钥键、多行默认值与「取值在别处」的键一律不写取值：前者受「不写样例密钥」约束，多行值写出来不可直接使用，
  // 后者是受版本控制的模板不该承载的值（部署模板里由仓库根 .env 提供的键）。
  const value = entry.secret || entry.multilineDefault || entry.hideValue === true ? "" : (entry.defaultValue ?? "");
  lines.push(`# ${entry.key}=${value}`);
  return lines;
}

/** 声明面之外、该场景额外保留的键。 */
function renderUndeclared(keys: readonly UndeclaredKey[]): string[] {
  const lines = [`# ── 声明面之外的键（${keys.length} 个）`.padEnd(96, "─"), ""];
  for (const item of keys) {
    lines.push(`# ${item.key}｜未被声明｜消费方：${item.consumer}`, `#   ${item.description}`, `# ${item.key}=`, "");
  }
  return lines;
}

/** 渲染一份模板：文件头 → 按 owner 分组的声明面全量键 → 场景补充键。 */
function renderTemplate(template: EnvTemplate, entries: readonly EnvEntry[]): string {
  const lines = ["#".repeat(100), `# ${template.title}`, "#".repeat(100)];
  for (const line of template.preamble) lines.push(line.length === 0 ? "#" : `# ${line}`);
  lines.push("");

  const byOwner = new Map<string, EnvEntry[]>();
  for (const entry of entries) {
    const bucket = byOwner.get(entry.owner);
    if (bucket === undefined) byOwner.set(entry.owner, [entry]);
    else bucket.push(entry);
  }
  const owners = [...byOwner.keys()].sort(template.surface === "deploy" ? compareDeployOwners : compareOwners);
  for (const owner of owners) {
    const header = `# ── ${owner} `;
    lines.push(header.padEnd(96, "─"), "");
    for (const entry of byOwner.get(owner) ?? [])
      lines.push(...renderEntry(entry, template.overrides?.[entry.key]), "");
  }

  if (template.undeclared !== undefined && template.undeclared.length > 0) {
    lines.push(...renderUndeclared(template.undeclared));
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** 宿主段恒在最前，其余模块按 id 排序：顺序稳定，模板 diff 才只反映内容变化。 */
function compareOwners(left: string, right: string): number {
  if (left === right) return 0;
  if (left === HOST_OWNER) return -1;
  if (right === HOST_OWNER) return 1;
  return left.localeCompare(right);
}

/** 部署模板不按字典序，按部署者的阅读顺序：开关 → common 可选服务 → 部署参数 → 仓库根 .env 的键。 */
function compareDeployOwners(left: string, right: string): number {
  return DEPLOY_OWNER_ORDER.indexOf(left) - DEPLOY_OWNER_ORDER.indexOf(right);
}

/** 校验场景差异没有拼错键名：覆盖一个不存在的键是纯粹的无声失效。 */
function assertTemplateOverrides(entries: readonly EnvEntry[]): void {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  for (const template of ENV_TEMPLATES) {
    for (const key of Object.keys(template.overrides ?? {})) {
      if (!byKey.has(key)) {
        throw new Error(`模板 ${template.path} 覆盖了声明面之外的键 ${key}；场景键请写进 undeclared`);
      }
    }
    for (const item of template.undeclared ?? []) {
      if (byKey.has(item.key)) {
        throw new Error(`模板 ${template.path} 的 undeclared 列了已声明的键 ${item.key}；请改在声明面补说明`);
      }
    }
  }
}

export interface EnvExampleDrift {
  /** 仓库相对路径。 */
  readonly path: string;
  readonly detail: string;
}

/** 首个差异行定位；整行过长时截断，避免把整份模板灌进 CI 日志。 */
function describeDifference(expected: string, actual: string): string {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const index = expectedLines.findIndex((line, offset) => line !== actualLines[offset]);
  const at = index === -1 ? Math.min(expectedLines.length, actualLines.length) : index;
  const show = (line: string | undefined) => (line === undefined ? "<无此>" : line.slice(0, 100));
  return (
    `生成结果 ${expectedLines.length} 行，现有文件 ${actualLines.length} 行；首个差异在第 ${at + 1} 行\n` +
    `      生成：${show(expectedLines[at])}\n      现有：${show(actualLines[at])}`
  );
}

/** 生成三份模板并返回写出的仓库相对路径；可注入 `repositoryRoot` 供测试在临时目录里校验。 */
export async function generateEnvExamples(options: { repositoryRoot?: string } = {}): Promise<readonly string[]> {
  const root = options.repositoryRoot ?? REPOSITORY_ROOT;
  const entries = collectEnvEntries();
  assertTemplateOverrides(entries);
  const deployEntries = await collectDeployEntries();

  for (const template of ENV_TEMPLATES) {
    const absolute = resolve(root, template.path);
    await mkdir(dirname(absolute), { recursive: true });
    const body = renderTemplate(template, template.surface === "deploy" ? deployEntries : entries);
    await writeFile(absolute, body, "utf8");
  }
  return ENV_TEMPLATES.map((template) => template.path);
}

/** 模板与声明面的漂移；空数组表示三份模板都与生成结果逐字节一致。 */
export async function findEnvExampleDrift(
  options: { repositoryRoot?: string } = {},
): Promise<readonly EnvExampleDrift[]> {
  const root = options.repositoryRoot ?? REPOSITORY_ROOT;
  const entries = collectEnvEntries();
  assertTemplateOverrides(entries);
  const deployEntries = await collectDeployEntries();

  const drift: EnvExampleDrift[] = [];
  for (const template of ENV_TEMPLATES) {
    const expected = renderTemplate(template, template.surface === "deploy" ? deployEntries : entries);
    let actual: string;
    try {
      actual = await readFile(resolve(root, template.path), "utf8");
    } catch {
      drift.push({ path: template.path, detail: "模板不存在，运行生成器产出" });
      continue;
    }
    if (actual !== expected) drift.push({ path: template.path, detail: describeDifference(expected, actual) });
  }
  return drift;
}

/** 执行门禁并返回进程退出码。 */
export async function checkEnvExamples(options: { repositoryRoot?: string } = {}): Promise<number> {
  const drift = await findEnvExampleDrift(options);
  if (drift.length === 0) {
    console.log("✓ env-example");
    return 0;
  }

  console.error(`部署环境变量模板与声明面存在 ${drift.length} 处漂移——三份模板都是生成物，不要手改：`);
  for (const item of drift) console.error(`  ${item.path}\n      ${item.detail}`);
  console.error("运行 `bun run scripts/generate-env-example.ts` 重新生成并提交产物。");
  return 1;
}

if (import.meta.main) {
  if (process.argv.includes("--check")) process.exit(await checkEnvExamples());

  const written = await generateEnvExamples();
  console.log(`✓ env-example（已生成 ${written.length} 份模板）`);
  for (const path of written) console.log(`  ${path}`);
  process.exit(0);
}
