/**
 * 浏览器 web contribution 产物的生成入口（§1.6 T11c）。
 *
 * 为什么浏览器产物独立于 server registry：manifest 的 `web.contribution` 携带 React 组件
 * （导航图标来自 `lucide-react`）。若把它像 `create` 一样写进 `apps/generated/module-registry.ts`，
 * 服务端装配图会在 `bootstrap.ts` 导入 registry 的那一刻把整个浏览器依赖图拉进 server 进程。
 * 因此 manifest 里放的是**入口说明符字符串**，本生成器按该说明符静态 import，产物只被 `apps/web` 消费。
 *
 * 判定来源与 `generate-module-registry.ts` 完全一致（同一批 `fenix.module.ts`、同一套 AST 读取原语、
 * 同一份 profile），差别只在「读哪一个字段、产出哪一个文件」。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import {
  collectManifestCandidates,
  loadManifestSource,
  type ManifestSource,
  MODULE_ID_PATTERN,
  normalizePath,
  readExportTarget,
} from "./lib/module-manifest-source";

const GENERATED_HEADER = "// 此文件由 scripts/generate-web-contributions.ts 生成，请勿手动编辑。";

/** 受版本控制的 manifest 扫描根；与 server registry 生成器共用同一条 glob。 */
const MANIFEST_GLOBS = { apps: "apps/*/fenix.module.ts", packages: "packages/**/fenix.module.ts" } as const;

/**
 * 装配 profile 的默认位置；与 `apps/server/src/assembly-config.ts` 的 CE 绑定指向同一份文件。
 *
 * 只支持 JSON：浏览器产物是**构建期**固定交付，而 profile 的 YAML 形态是部署期覆盖入口。
 * 部署期换 profile 不会重新打包浏览器 bundle，二者的差异由 §1.6 T12 记入 `deploy/assembly/README.md`。
 */
const DEFAULT_PROFILE_FILE = "deploy/assembly/ce.json";

/** 浏览器贡献契约的类型出口；生成物据此约束每一项载荷。 */
const CONTRIBUTION_TYPE_MODULE = "@fenix/web-runtime/shell/contribution";
const CONTRIBUTION_TYPE_NAME = "WebAppContribution";

/** 生成或校验的配置。 */
export interface GenerateWebContributionsOptions {
  readonly repositoryRoot?: string;
  readonly profileFile?: string;
  readonly outputFile?: string;
  readonly check?: boolean;
}

/** 生成结果，供 CLI 与测试报告确定性条数。 */
export interface GenerateWebContributionsResult {
  readonly contributionCount: number;
  readonly outputFile: string;
}

/** 一项已被校验的浏览器贡献；产物只需要入口说明符本身。 */
type SelectedContribution = string;

/**
 * 读取并解析 profile。
 *
 * 只做「是合法 JSON 对象」这一层解析：字段级校验的权威在 `@fenix/platform-sdk` 的 `resolveProfile`，
 * 本生成器只重复它继续工作所必需的两条（`web` 与 `resources`/固定槽位），其余留给运行时。
 */
async function readProfile(profilePath: string): Promise<Record<string, unknown>> {
  let source: string;
  try {
    source = await readFile(profilePath, "utf8");
  } catch (error) {
    throw new Error(`装配 profile 不存在: ${profilePath}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`装配 profile 不是合法 JSON: ${profilePath}`, { cause: error });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`装配 profile 必须是对象: ${profilePath}`);
  }
  return parsed as Record<string, unknown>;
}

/** 读取 profile 的 `web` 列表：顺序即产物顺序，重复项直接失败。 */
function readProfileWebIds(profile: Record<string, unknown>, profilePath: string): readonly string[] {
  const web = profile.web;
  if (!Array.isArray(web)) throw new Error(`装配 profile 必须声明 web 数组: ${profilePath}`);
  for (const webId of web) {
    if (typeof webId !== "string" || !MODULE_ID_PATTERN.test(webId)) {
      throw new Error(`装配 profile 的 web 只能包含模块 ID: ${profilePath} (${String(webId)})`);
    }
  }

  const duplicates = web.filter((webId, index) => web.indexOf(webId) !== index);
  if (duplicates.length > 0) {
    throw new Error(`装配 profile 的 web 有重复项: ${duplicates.join(", ")}`);
  }

  return web;
}

/**
 * 静态读取「本次装配启用的服务端模块 ID」。
 *
 * 与 `resolveProfile` 的 `enabledIds` 同一口径：固定槽位 + `resources` 列表本身，不含传递依赖
 * （profile 的 `resources` 按契约必须是拓扑闭包，缺项会在装配校验里失败）。
 */
function readEnabledModuleIds(profile: Record<string, unknown>, profilePath: string): ReadonlySet<string> {
  const ids: string[] = [];
  for (const slot of ["identity", "accessControl", "agentRuntime"]) {
    const value = profile[slot];
    if (typeof value !== "string") throw new Error(`装配 profile 的 ${slot} 必须是模块 ID: ${profilePath}`);
    ids.push(value);
  }

  const resources = profile.resources;
  if (!Array.isArray(resources)) throw new Error(`装配 profile 必须声明 resources 数组: ${profilePath}`);
  for (const resourceId of resources) {
    if (typeof resourceId !== "string") throw new Error(`装配 profile 的 resources 只能包含模块 ID: ${profilePath}`);
    ids.push(resourceId);
  }

  return new Set(ids);
}

/**
 * 把一个 `@scope/pkg/subpath` 说明符解析为入口文件。
 *
 * 必须经包的 `exports` 解析而不是拼路径：说明符是**公开导出**，绕过 exports 就等于允许浏览器
 * 产物 import 包内任意文件（`no-cross-package-src` 门禁的正是这件事）。
 */
async function assertContributionEntry(
  repositoryRoot: string,
  specifier: string,
  byPackageName: ReadonlyMap<string, ManifestSource>,
): Promise<void> {
  const [scope, name, ...rest] = specifier.split("/");
  if (!scope || !name || rest.length === 0) {
    throw new Error(`web.contribution 必须是 "@scope/pkg/subpath" 形态的子路径入口说明符: ${specifier}`);
  }

  const packageName = `${scope}/${name}`;
  const owner = byPackageName.get(packageName);
  if (!owner) throw new Error(`web.contribution 指向未注册 workspace 包 ${packageName}: ${specifier}`);

  const exportKey = `./${rest.join("/")}`;
  const target = readExportTarget(owner.exportsField, exportKey);
  if (target === undefined) {
    throw new Error(
      `${packageName} 的 package.json 未在 exports 声明 "${exportKey}"（web.contribution = ${specifier}）`,
    );
  }

  const entryFile = normalizePath(relative(repositoryRoot, resolve(repositoryRoot, owner.packageDirectory, target)));
  if (!entryFile.startsWith(`${owner.packageDirectory}/`)) {
    throw new Error(`${packageName} 的 exports["${exportKey}"] 越出包目录: ${target}`);
  }

  try {
    await readFile(resolve(repositoryRoot, entryFile), "utf8");
  } catch (error) {
    throw new Error(`${packageName} 的 exports["${exportKey}"] 指向的入口文件不存在: ${entryFile}`, { cause: error });
  }
}

/** 按 profile 的 `web` 列表逐项校验，并保持列表顺序。 */
async function selectContributions(
  repositoryRoot: string,
  webIds: readonly string[],
  enabledIds: ReadonlySet<string>,
  sources: readonly ManifestSource[],
): Promise<readonly SelectedContribution[]> {
  const webById = new Map<string, ManifestSource>();
  const byPackageName = new Map<string, ManifestSource>();
  for (const source of sources) {
    byPackageName.set(source.packageName, source);
    if (!source.web) continue;

    // 与 `createModuleRegistry` 的 `webById` 同一判据：`web.id` 是全局唯一键。
    const owner = webById.get(source.web.id);
    if (owner) throw new Error(`Web 模块 ID 重复: ${source.web.id} (${owner.packageName} 与 ${source.packageName})`);
    webById.set(source.web.id, source);
  }

  const selected: SelectedContribution[] = [];
  for (const webId of webIds) {
    const owner = webById.get(webId);
    if (!owner?.web) throw new Error(`装配配置引用了未注册 Web 模块: ${webId}`);
    if (!enabledIds.has(owner.descriptor.id)) {
      throw new Error(`Web 模块 ${webId} 的服务端模块 ${owner.descriptor.id} 未启用`);
    }

    await assertContributionEntry(repositoryRoot, owner.web.contribution, byPackageName);
    selected.push(owner.web.contribution);
  }
  return selected;
}

function renderContributions(selected: readonly SelectedContribution[]): string {
  const imports = selected.map(
    (specifier, index) => `import { webContribution as webContribution${index} } from "${specifier}";`,
  );
  const names = selected.map((_, index) => `webContribution${index}`).join(", ");
  return [
    GENERATED_HEADER,
    "",
    ...imports,
    `import type { ${CONTRIBUTION_TYPE_NAME} } from "${CONTRIBUTION_TYPE_MODULE}";`,
    "",
    "/**",
    " * 装配 profile 选定的浏览器贡献，顺序与 `deploy/assembly/ce.json` 的 `web` 列表一致。",
    " *",
    " * 服务端侧的同名概念是 `bootstrap.webContributions`——那里拿到的是本文件每一条的**说明符字符串**；",
    " * 本文件是它的浏览器一半，真正把载荷 import 进来。两端由同一份 profile 与同一批 manifest 派生。",
    " */",
    `export const generatedWebContributions = [${names}] as const satisfies readonly ${CONTRIBUTION_TYPE_NAME}[];`,
    "",
  ].join("\n");
}

/** 按装配 profile 生成或校验只含静态 import 的浏览器 web contribution 产物。 */
export async function generateWebContributions(
  options: GenerateWebContributionsOptions = {},
): Promise<GenerateWebContributionsResult> {
  const repositoryRoot = resolve(options.repositoryRoot ?? resolve(import.meta.dir, ".."));
  const profileFile = resolve(repositoryRoot, options.profileFile ?? DEFAULT_PROFILE_FILE);
  const outputFile = resolve(options.outputFile ?? resolve(repositoryRoot, "apps/generated/web-contributions.ts"));

  const profile = await readProfile(profileFile);
  const webIds = readProfileWebIds(profile, profileFile);
  const enabledIds = readEnabledModuleIds(profile, profileFile);

  const candidates = await collectManifestCandidates(repositoryRoot, MANIFEST_GLOBS);
  const sources = await Promise.all(candidates.map((candidate) => loadManifestSource(repositoryRoot, candidate)));

  const selected = await selectContributions(repositoryRoot, webIds, enabledIds, sources);
  const generatedSource = renderContributions(selected);

  if (options.check) {
    let currentSource: string;
    try {
      currentSource = await readFile(outputFile, "utf8");
    } catch (error) {
      throw new Error(`浏览器 web contribution 产物不存在: ${normalizePath(relative(repositoryRoot, outputFile))}`, {
        cause: error,
      });
    }
    if (currentSource !== generatedSource) {
      throw new Error("浏览器 web contribution 产物已过期，请运行 bun run generate:web-contributions");
    }
  } else {
    await mkdir(dirname(outputFile), { recursive: true });
    await writeFile(outputFile, generatedSource);
  }

  return { contributionCount: selected.length, outputFile };
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const result = await generateWebContributions({ check });
  console.log(`${check ? "已验证" : "已生成"} ${result.contributionCount} 个 web contribution: ${result.outputFile}`);
}
