/** WebSocket 业务 code 与固定提示的协议定义；重连策略由各使用方自行决定。 */
export const WEBSOCKET_CODES = {
  INSTANCE_RECLAIMED: { code: 4001, message: "实例已回收，停止自动重连" },
  UNAUTHORIZED: {
    code: 4003,
    message: "认证失败，请检查 RCS_SECRET 与服务端 REGISTRY_SECRET 是否一致",
  },
  INVALID_REFERENCE: { code: 4004, message: "连接引用无效，停止自动重连" },
  MACHINE_UNAVAILABLE: { code: 4500, message: "machine 不可用，停止自动重连" },
  KEEPALIVE_TIMEOUT: { code: 4501, message: "客户端心跳超时，停止自动重连" },
  SPAWN_REJECTED: { code: 4502, message: "实例启动被拒绝，停止自动重连" },
  MACHINE_ALREADY_CONNECTED: {
    code: 4503,
    message: "machine 连接被拒绝，已有连接，停止自动重连",
  },
} as const;

const WEBSOCKET_CODES_BY_CODE = new Map<number, { code: number; message: string }>(
  Object.values(WEBSOCKET_CODES).map((definition) => [definition.code, definition]),
);

/** 根据 WebSocket code 获取固定提示；未知 code 返回通用提示。 */
export function getWebSocketCodeMessage(code: number): string {
  return WEBSOCKET_CODES_BY_CODE.get(code)?.message ?? `未知 WebSocket code[${code}]`;
}
