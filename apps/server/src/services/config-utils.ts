/**
 * 宿主密钥引用解析。
 *
 * `{env:NAME}` → `process.env[NAME]`，明文原样返回，空值 `null`。唯一消费方是
 * `services/resource-module-ports.ts` 的 `resolveSecretReference`：资源包不得读宿主环境变量
 * （环境真相来源只能是 `apps/server/src/env.ts`），因此密钥引用的解析实现由宿主注入。
 *
 * 本文件原有的 `/web/config/*` 共享工具已随路由迁出归零生产消费方，按「删除优于兼容」于任务 1.5c
 * 删除：`configSuccess` / `configError`（含 `configNotFound` / `configValidationError`）与 `toKeyHint`
 * 由包内自持（`@fenix/model-management` 的 `src/server/config-envelope.ts`，密钥提示改为传入解析器）；
 * `isValidResourceName` 与 `@fenix/agent-config` 的 `isValidAgentName` 逐字符等价；`safeJsonParse` /
 * `safeJsonStringify` 的唯一消费方就是那些旧路由，迁出后无人引用。保留各自的包内副本即可，
 * 宿主再留一份会让同一份协议出现两种定义。
 */

/** 解析 apiKey：明文直接返回，`{env:XXX}` 引用尝试环境变量 */
export function resolveApiKey(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const envMatch = raw.match(/^\{env:(.+)\}$/);
  return envMatch ? (process.env[envMatch[1]] ?? null) : raw;
}
