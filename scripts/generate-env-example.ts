/**
 * 部署环境变量模板生成器与漂移门禁。
 *
 * **为什么模板改成生成物**：`deploy/env/*.example` 是部署模板的真相来源（backend-development §5.4），但本条目
 * 开工时仓库里没有 `deploy/env/`；两份历史模板（根 `.env.example`、`docker/prod/.env.example`）相对声明面已整体
 * 过期——`SKILL_DIR`、`WORKSPACE_ROOT`、`YJS_MAX_CLIENTS`、`LANGFUSE_*`、`HERMES_*`、`GOTENBERG_URL`、
 * `ACPX_G_URL`、`PLUGIN_MARKET_REGISTRY_*` 在任何受版本控制的模板里都查不到，缺一个键就意味着该旋钮在部署时
 * 只能靠代码默认值。手写补全会继续漂移，所以三份模板都改为同一次渲染的产物，由 `--check` 按字节守住。
 *
 * **覆盖面** = 宿主 `apps/server/src/env.ts` 的自有键 + 生成 registry（`apps/generated/module-registry.ts`）里
 * **全部**模块的 `envDefinitions`；刻意不按 assembly profile 过滤——profile 描述运行拓扑，模板描述「这个进程能配
 * 哪些旋钮」，按 profile 过滤会让「换个 profile 才用到的键」永久没有落点。
 *
 * **三份产出的关系**：`deploy/env/rcs.example` 是真相来源（只含声明面全量键）；根 `.env.example` 与
 * `docker/prod/.env.example` 由同一次渲染加各自场景差异（文件头、逐键注记、该场景确有消费方但尚未在声明面上的
 * 键）。两条渲染不变量由 `scripts/__tests__/env-example-generator.test.ts` 守护：键行恒为注释行
 * （`HERMES_PLATFORMS` 一类键的空串与未设置语义不同，留成有效空行会改变行为）；密钥类键不写任何取值，连样例
 * 也不写。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { EnvDefinition, ModuleManifest } from "@fenix/platform-sdk";
import { z } from "zod/v4";
import { generatedModuleManifests } from "../apps/generated/module-registry";
import { parseEnv } from "../apps/server/src/env";
import {
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
  // 密钥键与多行默认值一律不写取值：前者受「不写样例密钥」约束，后者写出的是不可直接使用的跨行值。
  const value = entry.secret || entry.multilineDefault ? "" : (entry.defaultValue ?? "");
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
  for (const owner of [...byOwner.keys()].sort(compareOwners)) {
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

  for (const template of ENV_TEMPLATES) {
    const absolute = resolve(root, template.path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, renderTemplate(template, entries), "utf8");
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

  const drift: EnvExampleDrift[] = [];
  for (const template of ENV_TEMPLATES) {
    const expected = renderTemplate(template, entries);
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
