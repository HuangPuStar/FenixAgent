/**
 * Machine 文件信道（file-ws）在本包内使用的连接抽象。
 *
 * 为什么由本包声明而不是继续用宿主 `@server/transport/ws-types` / `@server/types/store`：这两个类型是
 * 「框架 WS 适配器」与「file-ws 连接登记项」的形状，唯一消费者就是本包的 file-ws 传输层（连接登记、请求
 * 发送、心跳巡检、关闭清理），属于本模块的接口而不是宿主的领域概念。声明为本包类型后，宿主 Elysia WS
 * 适配器与本包测试用的假连接都是结构等价的实现，无需共享一个类型文件。
 *
 * 结构上限刻意保持最小：只声明本包读写的成员。宿主 `apps/server/src/transport/ws-types.ts` 的同名类型
 * 结构上满足本接口，因此宿主传入的连接对象无需转换即兼容；反向不成立（宿主类型多出的注释与约束不参与
 * 结构判断）。
 */

/**
 * 最小 WebSocket 连接抽象：把传输处理器与框架 WS 类型解耦。
 *
 * `send` 同时承载文本帧（JSON 控制消息）与二进制帧（yjs:update 线协议）；纯文本端点忽略二进制变体。
 * `readyState` 的 1 表示 OPEN；`bufferedAmount` 仅适配器支持时存在，背压判定把缺失视为 0（未拥塞）。
 */
export interface WsConnection {
  /** 发送数据：文本帧（控制消息）或二进制帧。 */
  send(data: string | Uint8Array): void;
  /** 关闭连接，可带关闭码与原因。 */
  close(code?: number, reason?: string): void;
  /** 当前就绪状态（0=CONNECTING，1=OPEN，2=CLOSING，3=CLOSED）。 */
  readonly readyState: number;
  /** 未发送的缓冲字节数；适配器不支持时缺省，背压判定按 0 处理（永不算拥塞）。 */
  readonly bufferedAmount?: number;
}

/** 单条 file-ws 连接的登记项（`/acp/file-ws` 端点，供远程文件操作使用）。 */
export interface FileWsConnectionEntry {
  /** 关联的 machine ID（注册帧之前为 null）。 */
  machineId: string | null;
  /** WS 连接。 */
  ws: WsConnection;
  /** 连接 ID。 */
  wsId: string;
  /** 连接打开时间（ms）。 */
  openTime: number;
  /** 最后活跃时间（ms，用于僵尸巡检）。 */
  lastClientActivity: number;
}
