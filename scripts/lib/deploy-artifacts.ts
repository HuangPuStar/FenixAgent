// 部署面产物的**渲染**原语：把「profile 选出的模块 + 各模块声明的依赖服务」变成可进版本控制的文本。
//
// 与 `release.ts` 分工：那边负责读 profile、校验声明与读写文件，这里只做纯函数渲染——渲染必须可被
// 单元测试单独断言（产物的字段顺序与注释头属于格式，改了就是改了交付面），混进 IO 与校验会让
// 「格式变了」和「声明错了」两类失败分不开。
import type { DependencyServiceDeclaration, ModuleDeploySource } from "./module-dependency-facts";
import { normalizePath } from "./module-manifest-source";

export const GENERATED_BY = "scripts/release.ts";
/** JSON/YAML 产物里的生成标记；比对按字节进行，字段名与顺序都属于产物格式。 */
export const GENERATED_NOTE = "生成物：请勿手改；改声明处后运行 `bun run scripts/release.ts`。";
export const GENERATED_HEADER = `# 此文件由 ${GENERATED_BY} 生成，请勿手动编辑。`;

/** 手工维护的基础编排：主服务进程不是模块（`apps/*` 只允许 web-shell manifest），无法从 manifest 派生。 */
export const BASE_COMPOSE_FILE = "deploy/compose/base.yml";

/** 合并后的依赖服务：定义字段来自声明方，`required` 取并集，`declaredBy` 记录谁依赖它。 */
export interface ResolvedService {
  readonly service: DependencyServiceDeclaration;
  readonly required: boolean;
  readonly declaredBy: readonly string[];
}

/** 模块 overlay 的路径：只有声明了本仓编排服务的模块才产出文件。 */
export function overlayFileFor(moduleId: string): string {
  return `deploy/compose/overlays/${moduleId}.yml`;
}

/** 部署形态字段：同一服务被多方声明时必须逐字一致，否则同一栈会有两种编排定义。 */
function serviceShape(service: DependencyServiceDeclaration): string {
  return JSON.stringify({
    composeFile: service.composeFile ?? null,
    healthCheck: service.healthCheck,
    image: service.image ?? null,
    orchestration: service.orchestration,
    ports: service.ports,
  });
}

/** 按 ID 合并各模块声明的依赖服务，并校验同一服务的声明一致性。 */
export function resolveServices(
  moduleIds: readonly string[],
  byId: ReadonlyMap<string, ModuleDeploySource>,
): ResolvedService[] {
  const merged = new Map<string, { service: DependencyServiceDeclaration; required: boolean; declaredBy: string[] }>();

  for (const moduleId of moduleIds) {
    for (const service of byId.get(moduleId)?.dependencyServices ?? []) {
      const existing = merged.get(service.id);
      if (!existing) {
        merged.set(service.id, { declaredBy: [moduleId], required: service.required, service });
        continue;
      }
      if (serviceShape(existing.service) !== serviceShape(service)) {
        throw new Error(
          `依赖服务 ${service.id} 被 ${existing.declaredBy[0]} 与 ${moduleId} 声明成不同形态：` +
            "镜像、端口、编排入口与探针必须一致，否则同一服务会有两份编排定义",
        );
      }
      existing.declaredBy.push(moduleId);
      // 只要有模块断言必需，部署前自检就必须阻断：取并集而不是取首个声明的值。
      existing.required = existing.required || service.required;
    }
  }

  // 稳定排序：产物进版本控制，顺序不能随声明顺序或遍历顺序漂移（代码单元序，不受构建机 locale 影响）。
  return [...merged.values()]
    .map((entry) => ({ declaredBy: [...entry.declaredBy].sort(), required: entry.required, service: entry.service }))
    .sort((left, right) => (left.service.id < right.service.id ? -1 : 1));
}

/** 探针的可读描述：部署方据此手工复现同一次探活。 */
export function describeHealthCheck(service: DependencyServiceDeclaration): string {
  const { healthCheck } = service;
  if (healthCheck.kind === "http") return `http \${${healthCheck.addressKey}}${healthCheck.path}`;
  return `tcp \${${healthCheck.addressKey}}`;
}

/** 渲染模块事实索引；字段顺序即产物格式。 */
export function renderModulesIndex(sources: readonly ModuleDeploySource[]): string {
  const modules = [...sources]
    .sort((left, right) => (left.descriptor.id < right.descriptor.id ? -1 : 1))
    .map((source) => ({
      capabilities: [...source.capabilities].sort(),
      dependencyServices: source.dependencyServices.map((service) => ({
        healthCheck: service.healthCheck,
        id: service.id,
        orchestration: service.orchestration,
        required: service.required,
        ...(service.composeFile === undefined ? {} : { composeFile: service.composeFile }),
        ...(service.image === undefined ? {} : { image: service.image }),
        ...(service.envKeys.length === 0 ? {} : { envKeys: [...service.envKeys] }),
      })),
      dependsOn: [...source.descriptor.dependsOn].sort(),
      id: source.descriptor.id,
      kind: source.descriptor.kind,
      manifest: normalizePath(source.candidate.manifestFile),
      package: source.packageName,
    }));

  return `${JSON.stringify({ generatedBy: GENERATED_BY, modules, note: GENERATED_NOTE }, null, 2)}\n`;
}

/**
 * 渲染模块的依赖服务 overlay。
 *
 * 只有 `compose-overlay` 的服务在这里定义；`separate` 的服务写成注释与入口指针——它们的编排在别处
 * （第三方产品栈或本仓独立部署单元），在这里再定义一遍就是同一栈的第二份真相。
 *
 * 服务上不写 compose `profiles`：叠加/去掉本文件本身就是该模块依赖面的启停开关，再套一层 profile
 * 会让「按 profile 启动」与「按 -f 叠加」两套开关互相干扰。
 */
export function renderOverlay(moduleId: string, services: readonly DependencyServiceDeclaration[]): string {
  const lines = [GENERATED_HEADER, `#`, `# 模块 ${moduleId} 声明的依赖服务：叠加本文件即启停它们。`];

  for (const service of services.filter((entry) => entry.orchestration === "separate")) {
    lines.push(
      `# ${service.id}：编排入口 ${service.composeFile}（探针 ${describeHealthCheck(service)}），本文件不重复定义。`,
    );
  }

  for (const service of services.filter((entry) => entry.orchestration === "compose-overlay")) {
    lines.push(`services:`, `  ${service.id}:`, `    image: ${service.image}`);
    if (service.ports.length > 0) {
      lines.push("    ports:");
      for (const port of service.ports) lines.push(`      - "${port}"`);
    }
    lines.push("    restart: unless-stopped");
  }

  return `${lines.join("\n")}\n`;
}

/** 渲染 profile 的部署视图：启用了哪些模块、因此需要哪些服务与探针、该用哪几个 compose 文件启动。 */
export function renderProfileView(
  profileId: string,
  profileFile: string,
  moduleIds: readonly string[],
  services: readonly ResolvedService[],
): string {
  const overlayFiles = [
    ...new Set(
      services
        .filter((entry) => entry.service.orchestration === "compose-overlay")
        .flatMap((entry) => entry.declaredBy.map(overlayFileFor)),
    ),
  ].sort();
  const composeFiles = [BASE_COMPOSE_FILE, ...overlayFiles];

  return `${JSON.stringify(
    {
      compose: {
        files: composeFiles,
        up: `docker compose ${composeFiles.map((file) => `-f ${file}`).join(" ")} up -d`,
      },
      dependencyServices: services.map((entry) => ({
        declaredBy: [...entry.declaredBy],
        description: entry.service.description,
        healthCheck: entry.service.healthCheck,
        id: entry.service.id,
        orchestration: entry.service.orchestration,
        required: entry.required,
        ...(entry.service.envKeys.length === 0 ? {} : { envKeys: [...entry.service.envKeys] }),
        ...(entry.service.composeFile === undefined ? {} : { composeFile: entry.service.composeFile }),
        ...(entry.service.orchestration === "compose-overlay"
          ? { overlays: entry.declaredBy.map(overlayFileFor) }
          : {}),
      })),
      enabledModules: [...moduleIds],
      generatedBy: GENERATED_BY,
      note: GENERATED_NOTE,
      profile: profileId,
      profileFile,
    },
    null,
    2,
  )}\n`;
}
