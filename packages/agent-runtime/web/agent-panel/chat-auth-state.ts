/**
 * ChatPanel 的登录态（user session）解析。
 *
 * Y.Doc key（rcsSessionKey）由 userId 参与哈希派生；userId 未就绪时建连会把
 * 服务端快照写入错误命名空间（历史竞态根因），因此建连前必须等待登录态就绪。
 * 此前该等待被吞进 connectionState="connecting"：auth 悬挂（useSession 慢/失败）
 * 时 UI 永驻转圈且无超时、无错误、无重试出口。
 *
 * 本模块把登录态显式建模为三态，供 ChatPanel 分别渲染加载/就绪/失败，
 * 与"连接中"（WS 建连阶段）语义彻底分离。
 */

export type ChatAuthState = "loading" | "ready" | "failed";

export interface ChatAuthInput {
  /** useSession 请求进行中（首次加载） */
  pending: boolean;
  /** useSession 请求失败（网络/服务端异常） */
  error: unknown;
  /** 已登录用户的 id；未登录/会话失效时为 undefined */
  userId: string | undefined;
}

/**
 * 由 useSession 结果推导登录态：
 * - 请求失败 → failed（明确错误态，提供重试出口）
 * - 请求进行中 → loading（展示加载态，而非"连接中"）
 * - 请求完成但无用户 → failed（未登录/会话失效，永转圈是体验黑洞）
 * - 有用户 → ready（允许建连）
 */
export function resolveChatAuthState(input: ChatAuthInput): ChatAuthState {
  if (input.error) return "failed";
  if (input.pending) return "loading";
  if (!input.userId) return "failed";
  return "ready";
}
