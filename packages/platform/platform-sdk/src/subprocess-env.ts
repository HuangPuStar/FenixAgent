/**
 * 子进程环境白名单原语（ce-ee-engineering-standards §5.4：子进程只获得按模块显式构造的白名单）。
 *
 * 为什么这个原语在平台层而不是各模块内：白名单的**键集**是各模块自己的领域知识（目录打包要 `PATH` /
 * `TZ`、Office 转换要 `HOME` / `TMPDIR`，各自按用途命名并写好逐键理由），但**取值**只能来自宿主进程
 * 环境。资源包内直读 `process.env` 被 §1.5 的包边界条件禁止（`@fenix/resource-machine` 与
 * `@fenix/resource-mcp` 的边界契约测试对生产 `src/**` 零例外扫描），宿主进程环境因此收敛到这里——
 * 与同层的 `env-loader` 同一取向：本模块只提供读法，不携带任何部署默认值、不缓存、不写回进程环境。
 *
 * 与 `loadDeclaredEnv` 的区别：那个读的是**已声明**的模块配置键（含 zod 校验与默认值），本函数读的是
 * 未声明的宿主环境变量（`PATH`、`TZ`、`HOME` 一类进程运行前提），供调用方按用途挑子集交给子进程。
 */

/**
 * 按白名单键集从宿主进程环境取值。
 *
 * 白名单外的键一律不出现（含宿主密钥与会被外部工具当命令行选项读的变量，如 zip 的 `ZIPOPT`）；未设置的
 * 键不产生 `undefined` 值，保证结果可直接作为 `spawn` / `Bun.spawn` 的 `env` 使用。返回值是新对象，
 * 调用方对它的写入不会污染进程环境。
 *
 * @param keys 该用途真正需要的键；调用方负责在常量旁写明逐键理由与缺失后果。
 * @param base 打底来源，仅测试用于注入；生产固定为 `process.env`（每次调用现取，用例改 `PATH` 立即生效）。
 */
export function pickProcessEnv(keys: readonly string[], base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of keys) {
    const value = base[key];
    if (value === undefined) continue;
    picked[key] = value;
  }
  return picked;
}
