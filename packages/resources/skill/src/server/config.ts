import { getModuleConfig } from "@fenix/platform-sdk/server";
import * as z from "zod/v4";

/**
 * Skill 模块的部署配置。
 *
 * 值的来源是宿主 `apps/server` 已解析并校验过的 env（`apps/server/src/env.ts` 是变量真相来源），由宿主
 * 在装配阶段经 `initializeApplicationInfrastructure({ moduleConfigs: { skill } })` 注入。包内不做
 * 第二份环境解析（既不读运行环境变量，也不读 `.env` 文件）：两处默认值一旦分歧便无法在启动期暴露，
 * 也会把部署知识泄漏进资源模块。
 *
 * 命名提示：本文件是**模块配置**；包导出面里的 `@fenix/resource-skill/server/config` 指
 * `src/server-config.ts`，那是 Agent ↔ Skill 关联表的能力出口，两者同名但不是一回事（关联表迁出时
 * 后者会先消失）。
 *
 * 这些字段暂由宿主直接提供，而不是走模块 `envDefinitions`（声明、校验与 preflight 收敛归任务 1.7）。
 */
export interface SkillModuleConfig {
  /** 技能源目录与归档的根目录（宿主解析 `SKILL_DIR` 之后的绝对路径）。 */
  readonly skillDir: string;
  /**
   * 对外基址，用于拼接带签名 token 的下载 URL。
   *
   * 宿主传入的是已解析结果（`RCS_BASE_URL` 缺省时回退为 `http://localhost:<port>`），本包不再读
   * `RCS_PORT` 之类的变量；拼接处仍会去掉尾部斜杠，避免基址带 `/` 时出现双斜杠路径。
   */
  readonly baseUrl: string;
  /**
   * 下载 token 的 HMAC 签名密钥候选（来自宿主 `RCS_API_KEYS` 的逗号分隔列表），取第一个非空项。
   *
   * 密钥材料只在本进程内使用：不得写入日志、错误信息或任何响应。用数组而不是单值，是因为签名期间
   * 允许密钥轮换（多 key 并存，取首个有效项），与宿主既有语义一致。
   */
  readonly downloadTokenSigningKeys: readonly string[];
}

/**
 * 模块配置的形状校验。
 *
 * `getModuleConfig()` 对模块配置的类型是调用方断言（平台契约返回 `unknown`），宿主 `main.ts` 的
 * 字面量落在宽松的 `Readonly<Record<string, unknown>>` 上——两处都不校验字段齐全与类型，漏一个必填
 * 字段会让代码在更远处（如构造下载 URL 时）才以异常行为暴露。
 *
 * `z.ZodType<SkillModuleConfig>` 的标注让「接口加了字段而 schema 没加」在编译期报错；schema 多出的
 * 字段由 `strictObject` 在运行期拒绝（宿主字段改名、拼写错误会立刻失败，而不是静默忽略）。
 * `downloadTokenSigningKeys` 只校验形状、不校验非空：宿主 env 已要求 `RCS_API_KEYS` 非空，
 * 这里若要求「至少一个非空项」会把密钥轮换中的空占位（`"a,,b"`）判成启动失败。
 */
const SkillModuleConfigSchema: z.ZodType<SkillModuleConfig> = z.strictObject({
  skillDir: z.string().min(1),
  baseUrl: z.string().min(1),
  downloadTokenSigningKeys: z.array(z.string()),
});

/**
 * 读取 Skill 模块的已校验配置。
 *
 * 只能在请求、任务或启动逻辑中调用：模块加载期宿主可能尚未完成基础设施初始化，那时读取会抛错。
 */
export function getSkillConfig(): SkillModuleConfig {
  const raw = getModuleConfig("skill");
  const parsed = SkillModuleConfigSchema.safeParse(raw);
  if (!parsed.success) {
    // 只报字段路径与错误码，不回显字段值：本配置含签名密钥，错误信息会被日志与错误响应带走。
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`);
    throw new Error(`skill 模块配置校验失败（${issues.join(", ")}）`);
  }
  return parsed.data;
}
