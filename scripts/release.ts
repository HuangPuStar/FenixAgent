/**
 * 部署入口（§8 脚本表的 `release`）：按静态装配 profile + 各模块 manifest 生成/校验部署面。
 *
 * 生成三个产物，全部进版本控制：
 * 1. `deploy/manifests/modules.json`——已注册模块的事实索引（`id` / `kind` / `capabilities` /
 *    `dependsOn` / `dependencyServices`），供 profile 与 preflight 校验：不启动应用就能查
 *    「这个镜像里有哪些模块、各自要什么服务」；
 * 2. `deploy/manifests/profiles/<profile>.json`——**按 profile 生成**的部署视图：启用了哪些模块、
 *    因此需要哪些依赖服务与探针、该用哪几个 compose 文件启动；
 * 3. `deploy/compose/overlays/<module>.yml`——模块的依赖服务编排片段，声明为 `compose-overlay` 的服务
 *    在这里定义，叠加即启停该模块的依赖。
 *
 * 本文件默认只做**生成与校验**，不执行迁移与容器启停：那两步已有权威入口（容器内 `bun migrate.js` 先于应用
 * 进程、`docker compose ... up -d` 由部署平台执行），在这里再实现一遍等于造第二套部署机制。只有显式给出
 * `--deploy` 时才把发布顺序串起来执行（第 0 步部署面校验 → DDL 迁移 → 数据迁移 → 容器部署，失败即停）——
 * 每一步仍调用上面那些既有入口：迁移调 `scripts/migrate.ts` 与 `db/data-migration-runner.ts`，容器部署的
 * 命令文本直接取自生成的部署视图（本文件不拼第二份命令）。生成物一律带「勿手改」头注释，漂移由 `--check`
 * 拦住（与 `generate-module-registry` / `generate-web-contributions` 同一口径：声明处改完必须重新生成）。
 *
 * 判定与不变量：
 * - 只读 manifest 静态事实（`scripts/lib/module-manifest-source.ts` 的 AST 读取原语），不执行 manifest；
 * - profile 与 registry 使用同一套语义：ID 必须已注册、`kind` 必须匹配槽位、`dependsOn` 必须闭包、
 *   capability 不得重复——生成期就把「发布组合装不起来」拦下来，而不是等启动期抛错；
 * - 依赖服务声明在这里再校验一遍编排归属的必填字段与探针锚点：`createModuleRegistry` 有同样的校验，
 *   但那条路径要等应用启动，而生成物进版本控制，错了必须先在这里失败。
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";

import {
  overlayFileFor,
  renderModulesIndex,
  renderOverlay,
  renderProfileView,
  resolveServices,
} from "./lib/deploy-artifacts";
import { type ModuleDeploySource, readModuleDeployFacts } from "./lib/module-dependency-facts";
import {
  collectManifestCandidates,
  loadManifestSource,
  MODULE_ID_PATTERN,
  normalizePath,
} from "./lib/module-manifest-source";
import {
  buildReleaseSteps,
  createReleaseStepRunner,
  DEPLOY_SURFACE_STEP,
  describeReleaseFailure,
  ReleaseStepError,
  type ReleaseStepIo,
  type ReleaseStepRunner,
  releaseStepDescriptors,
  runReleaseSteps,
} from "./lib/release-steps";

/**
 * 完全归生成器所有的目录：只有这些目录会被清理，其余产物按精确路径逐个校验。
 *
 * 单独列出来的原因是「目录所有权」：`deploy/manifests/README.md` 与 `deploy/compose/base.yml` 是手写
 * 事实，不能被当作残留删掉。
 */
const OWNED_DIRECTORIES = ["deploy/compose/overlays", "deploy/manifests/profiles"] as const;

/** 受版本控制的 manifest 扫描根；与另外两个生成器共用同一条 glob。 */
const MANIFEST_GLOBS = { apps: "apps/*/fenix.module.ts", packages: "packages/**/fenix.module.ts" } as const;

/**
 * 装配 profile 的默认位置；与 `apps/server/src/assembly-config.ts` 的 `CE_ASSEMBLY_PROFILE_PATH`
 * 和 `generate-web-contributions.ts` 的 `DEFAULT_PROFILE_FILE` 指向同一份文件。
 *
 * 三者必须同时改：应用侧的解析顺序（容器 `/app` 与本地三级上跳）由发布脚本固定，本脚本只是按同一约定
 * 读出部署视图，不引入第二条定位规则。
 */
const DEFAULT_PROFILE_FILE = "deploy/assembly/ce.json";

/** profile 中每个槽位要求的 `kind`；与 `ModuleRegistry.resolveProfile` 的校验一一对应。 */
const PROFILE_SLOTS = [
  ["identity", "identity"],
  ["accessControl", "access-control"],
  ["agentRuntime", "agent-runtime"],
  ["webShell", "web-shell"],
] as const;

/** 生成或校验的配置。 */
export interface ReleaseOptions {
  readonly repositoryRoot?: string;
  /** 装配 profile 路径（相对仓库根或绝对路径）；缺省用 CE 绑定的那份。 */
  readonly profileFile?: string;
  readonly check?: boolean;
}

/** 生成结果，供 CLI 与测试断言确定性条数。 */
export interface ReleaseResult {
  readonly profileId: string;
  readonly moduleCount: number;
  readonly enabledModuleCount: number;
  readonly dependencyServiceCount: number;
  readonly files: readonly string[];
}

function readStringArray(profile: Record<string, unknown>, key: string, profileFile: string): readonly string[] {
  const value = profile[key];
  if (!Array.isArray(value)) throw new Error(`装配 profile 必须声明 ${key} 数组: ${profileFile}`);
  for (const id of value) {
    if (typeof id !== "string" || !MODULE_ID_PATTERN.test(id)) {
      throw new Error(`装配 profile 的 ${key} 只能包含模块 ID: ${profileFile} (${String(id)})`);
    }
  }
  // 重复 ID 在装配层是硬错误，生成期直接拦下，避免产物描述一个装不起来的组合。
  const duplicates = value.filter((id, index) => value.indexOf(id) !== index);
  if (duplicates.length > 0) throw new Error(`装配 profile 的 ${key} 有重复项: ${duplicates.join(", ")}`);
  return value;
}

/**
 * 读取 profile 文件（JSON 或 YAML）。
 *
 * 与 `generate-web-contributions.ts` 同口径：只做「是合法对象」这一层解析，字段级校验的权威在
 * `@fenix/platform-sdk` 的 `parseAssemblyProfile`；这里只重复本脚本继续工作所必需的部分——它要按
 * profile 选出正确模块集合，选错的产物比没有产物更糟。
 *
 * 支持 YAML 是因为 profile 的 YAML 形态是部署期覆盖入口：部署方换 profile 时，部署视图必须跟着换。
 */
async function readProfile(profilePath: string): Promise<Record<string, unknown>> {
  const extension = extname(profilePath).toLowerCase();
  if (extension !== ".json" && extension !== ".yaml" && extension !== ".yml") {
    throw new Error("装配 profile 仅支持 .json、.yaml 或 .yml");
  }

  let source: string;
  try {
    source = await readFile(profilePath, "utf8");
  } catch (error) {
    throw new Error(`装配 profile 不存在: ${profilePath}`, { cause: error });
  }

  const parsed: unknown = extension === ".json" ? JSON.parse(source) : Bun.YAML.parse(source);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`装配 profile 必须是对象: ${profilePath}`);
  }
  return parsed as Record<string, unknown>;
}

/** profile 解析结果：固定槽位、资源列表、需要 server 实例化的模块序与浏览器贡献列表。 */
interface ProfileIds {
  readonly slots: ReadonlyMap<string, string>;
  readonly resourceIds: readonly string[];
  /** 与 `ModuleRegistry.resolveProfile` 的 `modules` 同序：三个基础槽位在前，资源按 profile 声明序。 */
  readonly serverModuleIds: readonly string[];
  readonly webIds: readonly string[];
}

/** 解析 profile 的固定槽位、资源列表与浏览器贡献列表。 */
function readProfileIds(profile: Record<string, unknown>, profileFile: string): ProfileIds {
  const slots = new Map<string, string>();
  for (const [key] of PROFILE_SLOTS) {
    const id = profile[key];
    if (typeof id !== "string" || !MODULE_ID_PATTERN.test(id)) {
      throw new Error(`装配 profile 的 ${key} 必须是模块 ID: ${profileFile}`);
    }
    slots.set(key, id);
  }

  const resourceIds = readStringArray(profile, "resources", profileFile);
  return {
    resourceIds,
    // Web Shell 是应用级组合，server 不实例化它，因此不进装配顺序（同 registry 的口径）。
    serverModuleIds: [
      slots.get("identity") as string,
      slots.get("accessControl") as string,
      slots.get("agentRuntime") as string,
      ...resourceIds,
    ],
    slots,
    webIds: readStringArray(profile, "web", profileFile),
  };
}

/**
 * 校验 profile 引用的模块存在、类别匹配、装配依赖闭包、capability 不冲突、Web 贡献归属已启用。
 *
 * 这是 `ModuleRegistry.resolveProfile` 在生成期的同一套判定：装不起来的发布组合必须在生成期失败，
 * 而不是等到容器启动才抛错。
 */
function validateProfile(ids: ProfileIds, byId: ReadonlyMap<string, ModuleDeploySource>, profileFile: string): void {
  for (const [key, kind] of PROFILE_SLOTS) {
    const id = ids.slots.get(key) as string;
    const manifest = byId.get(id);
    if (!manifest) throw new Error(`装配 profile 引用了未注册模块: ${id} (${profileFile})`);
    if (manifest.descriptor.kind !== kind) {
      throw new Error(`模块 ${id} 必须是 ${kind}，实际为 ${manifest.descriptor.kind} (${profileFile})`);
    }
  }

  for (const id of ids.resourceIds) {
    const manifest = byId.get(id);
    if (!manifest) throw new Error(`装配 profile 引用了未注册模块: ${id} (${profileFile})`);
    if (manifest.descriptor.kind !== "resource") {
      // 基础模块只能出现在自己的槽位：同时写进 `resources` 会让同一模块被装配两次。
      throw new Error(`模块 ${id} 是 ${manifest.descriptor.kind}，不能出现在 resources 列表 (${profileFile})`);
    }
  }

  for (const id of ids.serverModuleIds) {
    for (const dependencyId of byId.get(id)?.descriptor.dependsOn ?? []) {
      if (!ids.serverModuleIds.includes(dependencyId)) {
        throw new Error(`模块 ${id} 依赖未启用的模块 ${dependencyId} (${profileFile})`);
      }
    }
  }

  const capabilityOwners = new Map<string, string>();
  for (const id of ids.serverModuleIds) {
    for (const capability of byId.get(id)?.capabilities ?? []) {
      const owner = capabilityOwners.get(capability);
      if (owner) throw new Error(`capability ${capability} 同时由 ${owner} 与 ${id} 提供`);
      capabilityOwners.set(capability, id);
    }
  }

  for (const webId of ids.webIds) {
    const owner = [...byId.values()].find((source) => source.web?.id === webId);
    if (!owner) throw new Error(`装配配置引用了未注册 Web 模块: ${webId} (${profileFile})`);
    if (!ids.serverModuleIds.includes(owner.descriptor.id)) {
      throw new Error(`Web 模块 ${webId} 的服务端模块 ${owner.descriptor.id} 未启用 (${profileFile})`);
    }
  }
}

/**
 * 校验依赖服务声明。
 *
 * 与 `createModuleRegistry` 的 `assertDependencyServices` 是同一组不变量，重复在这里是因为失败时机不同：
 * 那条路径要等应用启动才执行，而部署产物进版本控制，声明写错必须让生成期（CI）直接失败。
 */
function validateDependencyServices(sources: readonly ModuleDeploySource[]): void {
  for (const source of sources) {
    const manifestFile = source.candidate.manifestFile;
    for (const service of source.dependencyServices) {
      for (const key of [service.healthCheck.addressKey, ...service.envKeys]) {
        if (!source.envKeys.includes(key)) {
          throw new Error(`依赖服务 ${service.id} 引用了未声明的环境变量 ${key} (${manifestFile})`);
        }
      }
      if (service.orchestration === "compose-overlay" && service.image === undefined) {
        throw new Error(`依赖服务 ${service.id} 由本仓编排时必须声明 image (${manifestFile})`);
      }
      if (service.orchestration === "compose-overlay" && service.composeFile !== undefined) {
        throw new Error(
          `依赖服务 ${service.id} 由本仓编排时不得声明 composeFile，其编排入口即本模块 overlay (${manifestFile})`,
        );
      }
      if (service.orchestration === "separate" && service.composeFile === undefined) {
        throw new Error(`依赖服务 ${service.id} 的编排在别处时必须声明 composeFile 作为入口指针 (${manifestFile})`);
      }
      if (service.orchestration === "separate" && (service.image !== undefined || service.ports.length > 0)) {
        throw new Error(`依赖服务 ${service.id} 的编排不在本仓时不得声明 image 或 ports (${manifestFile})`);
      }
    }
  }
}

/** 列出目录下的文件名（仅一层）；目录不存在返回空数组。 */
async function listDirectory(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

/** 比对产物字节；不一致即失败，避免「声明改了、部署面没跟上」的静默漂移。 */
async function assertUpToDate(repositoryRoot: string, file: string, expected: string): Promise<void> {
  let current: string;
  try {
    current = await readFile(resolve(repositoryRoot, file), "utf8");
  } catch (error) {
    throw new Error(`部署产物不存在: ${file}，请运行 bun run scripts/release.ts`, { cause: error });
  }
  if (current !== expected) {
    throw new Error(`部署产物已过期: ${file}，请运行 bun run scripts/release.ts`);
  }
}

/**
 * 列出生成目录里不属于生成物的文件（仅一层）。
 *
 * `deploy/compose/overlays/` 与 `deploy/manifests/profiles/` 归生成器完全所有——模块一旦不再声明本仓
 * 编排的服务，它的 overlay 就该消失。残留文件在 `--check` 下报错、在生成时删除，两者口径一致。
 */
async function listStrayFiles(
  repositoryRoot: string,
  directory: string,
  expectedFiles: readonly string[],
): Promise<readonly string[]> {
  const expectedNames = new Set(
    expectedFiles.filter((file) => file.startsWith(`${directory}/`)).map((file) => basename(file)),
  );
  const entries = await listDirectory(resolve(repositoryRoot, directory));
  return entries.filter((name) => !expectedNames.has(name));
}

/** 按装配 profile 生成或校验部署面（模块索引、profile 视图、模块 overlay）。 */
export async function release(options: ReleaseOptions = {}): Promise<ReleaseResult> {
  const repositoryRoot = resolve(options.repositoryRoot ?? resolve(import.meta.dir, ".."));
  const profileFile = normalizePath(options.profileFile ?? DEFAULT_PROFILE_FILE);
  const profileId = basename(profileFile, extname(profileFile));

  const profile = await readProfile(resolve(repositoryRoot, profileFile));
  const ids = readProfileIds(profile, profileFile);

  const candidates = await collectManifestCandidates(repositoryRoot, MANIFEST_GLOBS);
  const sources: ModuleDeploySource[] = await Promise.all(
    candidates.map(async (candidate) => {
      const source = await loadManifestSource(repositoryRoot, candidate);
      return { ...source, ...readModuleDeployFacts(source.sourceFile, candidate.manifestFile) };
    }),
  );
  const byId = new Map<string, ModuleDeploySource>(sources.map((source) => [source.descriptor.id, source]));
  if (byId.size !== sources.length) throw new Error("模块 ID 重复：manifest 扫描结果里有同名模块");

  validateDependencyServices(sources);
  validateProfile(ids, byId, profileFile);
  const services = resolveServices(ids.serverModuleIds, byId);

  const outputs: { readonly file: string; readonly content: string }[] = [
    { content: renderModulesIndex(sources), file: "deploy/manifests/modules.json" },
    {
      content: renderProfileView(profileId, profileFile, ids.serverModuleIds, services),
      file: `deploy/manifests/profiles/${profileId}.json`,
    },
  ];
  for (const moduleId of ids.serverModuleIds) {
    const declared = byId.get(moduleId)?.dependencyServices ?? [];
    if (!declared.some((service) => service.orchestration === "compose-overlay")) continue;
    outputs.push({ content: renderOverlay(moduleId, declared), file: overlayFileFor(moduleId) });
  }

  const ownedFiles = outputs.map((output) => output.file);
  if (options.check) {
    for (const output of outputs) await assertUpToDate(repositoryRoot, output.file, output.content);
    for (const directory of OWNED_DIRECTORIES) {
      const strays = await listStrayFiles(repositoryRoot, directory, ownedFiles);
      if (strays.length > 0) {
        throw new Error(`部署产物目录有非生成物残留: ${normalizePath(`${directory}/${strays[0]}`)}`);
      }
    }
  } else {
    for (const output of outputs) {
      const target = resolve(repositoryRoot, output.file);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, output.content);
    }
    // 生成模式与 `--check` 同口径：目录归生成器所有，声明删掉的服务其 overlay 一并消失。
    for (const directory of OWNED_DIRECTORIES) {
      for (const name of await listStrayFiles(repositoryRoot, directory, ownedFiles)) {
        await rm(resolve(repositoryRoot, directory, name));
      }
    }
  }

  return {
    dependencyServiceCount: services.length,
    enabledModuleCount: ids.serverModuleIds.length,
    files: outputs.map((output) => output.file),
    moduleCount: sources.length,
    profileId,
  };
}

/**
 * 执行发布的配置。
 *
 * `runStep` / `log` / `logError` 是**测试与集成的注入点**：用例用假执行器断言命令序列与「前一步失败即停」，
 * 不必真连数据库或真起容器。
 */
export interface DeployOptions extends ReleaseOptions {
  readonly runStep?: ReleaseStepRunner;
  readonly log?: (message: string) => void;
  readonly logError?: (message: string) => void;
}

/** 发布结果：profile、实际使用的启动命令，与按序成功的步骤。 */
export interface DeployResult {
  readonly profileId: string;
  readonly composeUp: string;
  readonly steps: readonly { readonly id: string; readonly title: string }[];
}

/**
 * 执行一次发布（§8 脚本表的「串联迁移、部署与失败判断」）。
 *
 * 第 0 步是**部署面校验**（与 `--check` 同一套判定，只读不写）：产物与声明不一致时按过期视图起容器，
 * 起到的会是另一个组合，所以在改动任何运行环境之前先停。之后依次调用既有权威入口，任何一步失败即停，
 * 失败输出由 `describeReleaseFailure()` 统一给出「哪一步、为什么、可重跑性」。
 */
export async function deploy(options: DeployOptions = {}): Promise<DeployResult> {
  const io: ReleaseStepIo = {
    log: options.log ?? ((message: string) => console.log(message)),
    logError: options.logError ?? ((message: string) => console.error(message)),
  };
  const repositoryRoot = resolve(options.repositoryRoot ?? resolve(import.meta.dir, ".."));
  const descriptors = releaseStepDescriptors();

  let verified: ReleaseResult;
  let composeUp: string;
  try {
    verified = await release({ check: true, profileFile: options.profileFile, repositoryRoot });
    const profileViewFile = `deploy/manifests/profiles/${verified.profileId}.json`;
    composeUp = readComposeUp(
      await readFile(resolve(repositoryRoot, profileViewFile), "utf8"),
      normalizePath(profileViewFile),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ReleaseStepError(DEPLOY_SURFACE_STEP, reason, descriptors, 0);
  }

  const executed = await runReleaseSteps(
    buildReleaseSteps(composeUp),
    options.runStep ?? createReleaseStepRunner(),
    io,
  );
  io.log(
    `[release] profile ${verified.profileId} 发布完成：${executed.length} 步全部成功` +
      `（${executed.map((step) => step.title).join(" → ")}）。`,
  );

  return {
    composeUp,
    profileId: verified.profileId,
    steps: executed.map((step) => ({ id: step.id, title: step.title })),
  };
}

/**
 * 读部署视图里的启动命令。
 *
 * 命令文本**只来自生成物**：profile 换了、模块的依赖服务换了，命令都跟着生成器走；在脚本里另拼一份就会
 * 出现「部署视图说三份编排、实际只起两份」这类不可见偏差。
 */
function readComposeUp(source: string, profileViewFile: string): string {
  const parsed: unknown = JSON.parse(source);
  const compose = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).compose : null;
  const up = typeof compose === "object" && compose !== null ? (compose as Record<string, unknown>).up : null;
  if (typeof up !== "string" || up.length === 0) {
    throw new Error(`部署视图缺少 compose.up: ${profileViewFile}，请运行 bun run release 重新生成`);
  }
  return up;
}

/**
 * 部署入口的 CLI。
 *
 * - 默认（不带开关）生成部署面；`--check` 校验漂移；两者都不执行迁移与容器启停；
 * - `--deploy` 执行发布：第 0 步部署面校验 → DDL 迁移 → 数据迁移 → 容器部署，任一步失败即停并输出定位；
 * - `--profile <path>` 指定装配 profile（相对仓库根或绝对路径）。
 */
async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const deployRequested = process.argv.includes("--deploy");
  const profileIndex = process.argv.indexOf("--profile");
  const profileFile = profileIndex === -1 ? undefined : process.argv[profileIndex + 1];
  if (profileIndex !== -1 && profileFile === undefined) throw new Error("--profile 需要一个装配 profile 路径");
  if (check && deployRequested) {
    // 两个开关语义相反（只读校验 / 改动运行环境），同时给出一律拒绝而不是猜一个：静默按其中一个执行，
    // 会让「我以为只是校验」变成真的起了容器。
    throw new Error("--check 与 --deploy 互斥：前者只校验部署面，后者执行发布（其第 0 步已含校验）");
  }

  if (deployRequested) {
    try {
      await deploy({ profileFile });
    } catch (error) {
      if (!(error instanceof ReleaseStepError)) throw error;
      for (const line of describeReleaseFailure(error)) console.error(line);
      process.exitCode = 1;
    }
    return;
  }

  const result = await release({ check, profileFile });
  console.log(
    `${check ? "已验证" : "已生成"} profile ${result.profileId} 的部署面：` +
      `${result.moduleCount} 个模块（启用 ${result.enabledModuleCount}）、${result.dependencyServiceCount} 个依赖服务`,
  );
  for (const file of result.files) console.log(`  ${check ? "✓" : "→"} ${file}`);
}

if (import.meta.main) await main();
