// packages/chat-channel/src/channel/error-cause.ts
// 启动/连接失败原因的**有界安全描述**，只用于服务端诊断日志。
//
// 为什么需要它（2026-09-01 事故复盘）：
// - 历史实现向日志传 `typeof err`，日志只剩 "object"，公开错误 Type + ID 无法回溯根因；
//   仅 2026-09-01 就有 2294 条 INSTANCE_START_FAILED 因此不可诊断。
// - 但也不能直接记录原始异常：docs/arch/23-chat-error-diagnostics.md 硬边界 7 要求原始
//   message / stack / payload 不进入普通日志；DB 异常还常携带 params（用户与组织 ID）。
//
// 取值限定为**错误身份 + 稳定机器码**：构造器名、AppError.code、OrchestrationError.code、
// CoreRuntimeError.code、Postgres SQLSTATE、Node errno——都是有限枚举，不含用户数据。
// 形如 `AppError:INSTANCE_NOT_FOUND`、`DrizzleQueryError<-PostgresError:42P01`。
//
// 契约：**永不抛错、永不返回空串、永不读取 message/stack/payload**。异常属性的读取可能被
// getter / Proxy 劫持而抛错（对抗评审已构造出可复现样本），而调用方用本函数的结果做日志
// 实参——一旦逃逸，同一行的 `ws.close()` 与公开错误帧就不会执行，终态判定被静默跳过。
// 因此所有属性访问都在 try 内完成，且白名单校验与最终取值使用**同一个字符串**：
// 若校验一次、插值一次，带状态的自定义 `toString` 可以在第二次返回任意文本绕过白名单。

/** 允许进入日志的机器码/标识字符集与长度上限（防御性收窄，避免第三方异常把自由文本塞进 code）。 */
const SAFE_IDENTITY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** cause 链最大展开层数；上限同时兜住自引用与环状 cause。 */
const MAX_CAUSE_DEPTH = 2;

/** 非法或不可读时的占位符，保证日志行结构稳定、字段数不随输入变化。 */
const UNKNOWN_IDENTITY = "unknown";

/** 读取异常上的稳定机器码（code 字段），不合规时返回 null。 */
function readSafeIdentityCode(error: Error): string | null {
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" && SAFE_IDENTITY_PATTERN.test(code) ? code : null;
}

/**
 * 校验并返回可安全写入日志的短标识（错误码、错误名、请求方提供的 instanceUid 等）。
 *
 * 请求方提供的标识不可信：直接插值可以伪造日志字段（对抗评审构造出
 * `instanceUid=inst_ok cause=AppError:...` 的样本，使一行出现两个 `cause=`）。
 * 非字符串或不满足白名单一律退化为固定占位符。
 */
export function describeSafeIdentifier(value: unknown, fallback: string = UNKNOWN_IDENTITY): string {
  return typeof value === "string" && SAFE_IDENTITY_PATTERN.test(value) ? value : fallback;
}

/**
 * 将任意异常压缩为有限、不含敏感信息的诊断标识。
 *
 * 契约：永不抛错、永不返回空串、永不读取 message/stack/payload。
 * 非 Error 值退化为 `typeof` 结果（如 `string`、`object`），保持与旧日志同样的可读性下限。
 */
export function describeErrorCause(error: unknown, depth = 0): string {
  try {
    if (error === null || error === undefined) return "none";
    if (!(error instanceof Error)) return typeof error;
    const name = describeSafeIdentifier(error.name, "Error");
    const code = readSafeIdentityCode(error);
    const self = code ? `${name}:${code}` : name;
    if (depth >= MAX_CAUSE_DEPTH) return self;
    const cause = describeErrorCause((error as Error & { cause?: unknown }).cause, depth + 1);
    return cause === "none" ? self : `${self}<-${cause}`;
  } catch {
    // 属性访问被劫持时退化为占位符：诊断日志可以少信息，但绝不能让异常从调用点逃逸。
    return UNKNOWN_IDENTITY;
  }
}
