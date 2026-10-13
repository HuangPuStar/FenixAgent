/**
 * workspace 包目录与稳定包名的解析。
 *
 * 架构门禁需要把「文件 → 文件」的违规归一成「包 → 包」的边界事实：包名才是设计矩阵
 * （§2.3）与例外台账使用的粒度，文件路径会随重构漂移。
 */

import { readFile } from "node:fs/promises";
import { join, sep } from "node:path";

/** workspace 内一个已声明 package.json 的包。 */
export interface WorkspacePackage {
  readonly name: string;
  /** 仓库相对 POSIX 路径，如 `packages/platform/platform-sdk`。 */
  readonly directory: string;
}

/** 仓库相对路径 ↔ 绝对路径的公共归一。 */
export function normalizePath(filePath: string): string {
  return filePath.split(sep).join("/");
}

interface RootManifest {
  readonly workspaces?: unknown;
}

/**
 * 读取根 `package.json` 的 workspaces 声明并解析出全部包。
 *
 * 目录清单以根声明为唯一来源；分组目录（如 `packages/platform`）自身没有 package.json，
 * 会被自动跳过。
 */
export async function loadWorkspacePackages(repositoryRoot: string): Promise<readonly WorkspacePackage[]> {
  let manifestSource: string;
  try {
    manifestSource = await readFile(join(repositoryRoot, "package.json"), "utf8");
  } catch (error) {
    // 门禁的行为夹具只临时创建需要的源码目录，没有 workspace 声明。此时不存在「包」这个概念，
    // 依赖声明类规则自然不适用；真实仓库的 package.json 缺失会在 JSON 解析前就抛错暴露问题。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const rootManifest = JSON.parse(manifestSource) as RootManifest;
  const globs = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces.filter((glob): glob is string => typeof glob === "string")
    : [];

  const directories = new Set<string>();
  for (const glob of globs) {
    for await (const match of new Bun.Glob(glob).scan({ cwd: repositoryRoot, onlyFiles: false })) {
      directories.add(normalizePath(match));
    }
  }

  const packages = await Promise.all(
    [...directories].sort().map(async (directory): Promise<WorkspacePackage | undefined> => {
      try {
        const manifest = JSON.parse(await readFile(join(repositoryRoot, directory, "package.json"), "utf8")) as {
          name?: unknown;
        };
        return typeof manifest.name === "string" ? { directory, name: manifest.name } : undefined;
      } catch {
        // 分组目录与未声明的中间目录没有 package.json，不构成 workspace 包。
        return;
      }
    }),
  );

  return packages.filter((entry): entry is WorkspacePackage => entry !== undefined);
}

/**
 * 创建「导入说明符 → 包名」解析器；非 workspace 包的说明符返回 `undefined`。
 *
 * 不能用 `@fenix/` 前缀推断包名：workspace 里存在无 scope 的 `acp-link` 与另一 scope 的
 * `@fenix-agent/acp-runtime-cli`，只认前缀会让这两类包的「导入但未声明」完全逃过门禁。
 * 以根 workspaces 声明为唯一来源还能排除同名但非 workspace 的外部包，避免误报。
 */
export function createSpecifierPackageResolver(
  packages: readonly WorkspacePackage[],
): (specifier: string) => string | undefined {
  const names = new Set(packages.map((entry) => entry.name));

  return (specifier: string): string | undefined => {
    const segments = specifier.split("/");
    // 从最长前缀开始收窄：`@fenix/chat-channel/server` → `@fenix/chat-channel`，`acp-link/client` → `acp-link`。
    for (let end = segments.length; end > 0; end -= 1) {
      const candidate = segments.slice(0, end).join("/");
      if (names.has(candidate)) return candidate;
    }
    return;
  };
}

/**
 * 创建「仓库相对文件路径 → 包名」解析器。
 *
 * 取最长前缀匹配：`packages/resources/agent-config/src/x.ts` 必须解析到
 * `packages/resources/agent-config`，而不是分组目录。无法归属的路径原样返回，便于在
 * 诊断里看出是哪个未登记的目录。
 */
export function createPackageNameResolver(packages: readonly WorkspacePackage[]): (relativePath: string) => string {
  const byDirectory = [...packages].sort((left, right) => right.directory.length - left.directory.length);

  return (relativePath: string): string => {
    const normalized = normalizePath(relativePath).replace(/^\.\//, "");
    for (const entry of byDirectory) {
      if (normalized === entry.directory || normalized.startsWith(`${entry.directory}/`)) return entry.name;
    }
    return normalized;
  };
}
