import { extname, resolve } from "node:path";
import { type AssemblyProfile, parseAssemblyProfile } from "@fenix/platform-sdk/assembly";

/**
 * 应用根：唯一的解析基准。打包部署必须声明 `RCS_APPLICATION_ROOT`（镜像 runtime 阶段 ENV 为 `/app`），
 * 未声明时按源码模块位置反推仓库根。
 *
 * 三种调用场景实测：
 * 1. `bun run dev`（根 `package.json` 的 dev 脚本，cwd = 仓库根）与直接 `bun apps/server/src/main.ts`：
 *    都不带该变量，`import.meta.dir` = `apps/server/src`，三级上跳即仓库根 → `<repo>/deploy/assembly/ce.json`。
 *    从模块位置推导使它不受调用 cwd 影响（从子目录调用同样命中）。
 * 2. 镜像内 `bun dist/index.js`（WORKDIR `/app`）：bundle 的 `import.meta.dir` = `/app/dist`，三级上跳落在
 *    容器根，故以 `RCS_APPLICATION_ROOT=/app` 为准 → `/app/deploy/assembly/ce.json`（runtime 阶段已 COPY）。
 *
 * 打包部署漏设该变量时路径会落到容器根，行为是启动期 ENOENT 明确失败——这里不设候选路径回退，
 * 口径与 `plugins/static.ts` 的应用根一致：源码模式从模块位置推导，打包部署读同一个绝对根目录。
 */
const applicationRoot = process.env.RCS_APPLICATION_ROOT ?? resolve(import.meta.dir, "../../..");

/** CE 发布入口固定的默认 assembly profile，不接受 profile 内反向指定路径。 */
export const CE_ASSEMBLY_PROFILE_PATH = resolve(applicationRoot, "deploy/assembly/ce.json");

/** 从发布入口选定的 JSON/YAML 文件读取并校验通用 assembly profile。 */
export async function loadAssemblyProfile(profilePath = CE_ASSEMBLY_PROFILE_PATH): Promise<AssemblyProfile> {
  const extension = extname(profilePath).toLowerCase();
  if (extension !== ".json" && extension !== ".yaml" && extension !== ".yml") {
    throw new Error("assembly profile 仅支持 .json、.yaml 或 .yml");
  }

  const source = await Bun.file(profilePath).text();
  const rawProfile: unknown = extension === ".json" ? JSON.parse(source) : Bun.YAML.parse(source);
  return parseAssemblyProfile(rawProfile);
}
