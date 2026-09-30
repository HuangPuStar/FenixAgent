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
 *
 * 应用根之上只拼一个相对落点：装配 profile 的 `<应用根>/deploy/assembly/ce.json`。部署面要换 profile 时用
 * `RCS_ASSEMBLY_PROFILE_PATH` 显式指定文件，而不是在本文件里加候选路径——候选路径会让「读的是哪一份 profile」
 * 取决于部署现场恰好存在哪些文件。
 */
const applicationRoot = process.env.RCS_APPLICATION_ROOT ?? resolve(import.meta.dir, "../../..");

/** CE 发布入口固定的默认 assembly profile，不接受 profile 内反向指定路径。 */
export const CE_ASSEMBLY_PROFILE_PATH = resolve(applicationRoot, "deploy/assembly/ce.json");

/** 环境变量来源；只读这几个键，故不必依赖完整的宿主 env 类型。 */
type EnvInput = Readonly<Record<string, string | undefined>>;

/** 按给定环境解析应用根：打包部署声明 `RCS_APPLICATION_ROOT`，源码运行按模块位置三级上跳。 */
function applicationRootOf(env: EnvInput): string {
  return env.RCS_APPLICATION_ROOT ?? resolve(import.meta.dir, "../../..");
}

/**
 * 解析装配 profile 的路径。
 *
 * **默认即 CE 入口的固定 profile**：`<RCS_APPLICATION_ROOT>/deploy/assembly/ce.json`，与
 * {@link CE_ASSEMBLY_PROFILE_PATH} 逐字相同——不传路径的调用方（`resolveAssemblyEnv()`）行为不变。
 * **部署面可用 `RCS_ASSEMBLY_PROFILE_PATH` 选定其它 assembly profile**（换产品线、灰度、受部署平台保护的
 * 只读挂载文件）；它只换文件，不换「profile 只能选已注册模块」这套判定，profile 文件自身仍不得反向指定
 * 路径。该键要求绝对路径（宿主 schema 的同名 refine）：相对路径随启动 cwd 漂移，读到的可能不是部署方
 * 以为的那一份。
 *
 * 做成「入参可注入的纯函数」而不是加载期常量，是因为**默认值与覆盖值的解析规则需要一条直接断言**——
 * 模块加载期读 `process.env` 的常量在测试里改不了环境；`loadAssemblyProfile()` 的缺省参数也经它取值，
 * 因此覆盖值对加载器同样生效。
 */
export function resolveAssemblyProfilePath(env: EnvInput = process.env): string {
  return env.RCS_ASSEMBLY_PROFILE_PATH ?? resolve(applicationRootOf(env), "deploy/assembly/ce.json");
}

/** 从发布入口选定的 JSON/YAML 文件读取并校验通用 assembly profile。 */
export async function loadAssemblyProfile(profilePath = resolveAssemblyProfilePath()): Promise<AssemblyProfile> {
  const extension = extname(profilePath).toLowerCase();
  if (extension !== ".json" && extension !== ".yaml" && extension !== ".yml") {
    throw new Error("assembly profile 仅支持 .json、.yaml 或 .yml");
  }

  const source = await Bun.file(profilePath).text();
  const rawProfile: unknown = extension === ".json" ? JSON.parse(source) : Bun.YAML.parse(source);
  return parseAssemblyProfile(rawProfile);
}
