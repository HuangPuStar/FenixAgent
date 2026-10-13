/**
 * `/web/config/*` 协议层的响应信封与密钥提示工具。
 *
 * 迁移前这三件事由宿主 `apps/server/src/services/config-utils.ts` 提供，资源包经 `@server/**` 深链取得。
 * 1.3 的硬边界要求包内 `src/**` 只允许 `@server/db/schema`，因此把本包真正用到的三个纯函数收进包内：
 * `configSuccess` / `configError` 是 `/web` 的通用回包形状，`toKeyHint` 是
 * Provider 视图的固定字段。宿主版本里其余导出（`configNotFound`、`isValidResourceName`、
 * `safeJsonParse` 等）本包未引用，不复制——「顺手搬一份」会把宿主的工具模块整体变成第二份实现。
 *
 * `resolveApiKey` 是**刻意没有**搬过来的那个：它读 `process.env`，而包内 `src/**` 禁止读环境变量
 * （1.3 硬条件 4：环境真相来源只能是宿主 `apps/server/src/env.ts`）。密钥引用解析改为经
 * {@link SecretReferenceResolver} 由宿主注入，见 `./routes/dependencies`。
 */

/** 统一成功响应；与宿主 `configSuccess` 形状逐字一致（`success` 收窄为 `true` 字面量）。 */
export function configSuccess<T>(data: T) {
  return { success: true as const, data };
}

/**
 * 统一错误响应。
 *
 * `data` 只在显式传入时出现：探测类失败会带诊断信息，普通失败不带该键——迁移前后端与用例都按
 * 「键存在与否」断言，不能无条件补 `data: undefined`。
 */
export function configError(code: string, message: string, data?: unknown) {
  return { success: false as const, error: { code, message }, ...(data !== undefined ? { data } : {}) };
}

/**
 * 密钥引用解析：`{env:NAME}` 取宿主环境变量，其余值按明文返回，空值返回 `null`。
 *
 * 类型放在包内、实现由宿主提供：解析要用到宿主的 env（`apps/server/src/env.ts` 是环境变量真相来源），
 * 资源包不得自建第二份环境读取。
 */
export type SecretReferenceResolver = (raw: string | undefined | null) => string | null;

/**
 * 从 apiKey 字段生成 keyHint：只暴露前 4 位与后 3 位，短 key 或空 key 返回固定掩码。
 *
 * 先解析再截取：库里存的是 `{env:NAME}` 引用时，提示必须反映真实密钥的长度与首尾，否则运维无法用它
 * 比对上游控制台里的 key。解析结果为空（引用未配置）时与空 key 同路——不泄露「某个引用名存在」。
 */
export function toKeyHint(
  apiKey: string | undefined | null,
  resolveSecretReference: SecretReferenceResolver,
): string | null {
  const realKey = resolveSecretReference(apiKey);
  if (!realKey || realKey.length <= 7) return "*******";
  return `${realKey.slice(0, 4)}***${realKey.slice(-3)}`;
}
