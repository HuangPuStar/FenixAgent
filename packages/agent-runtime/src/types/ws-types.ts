/**
 * 本包内使用的 WebSocket 连接抽象。
 *
 * 为什么由本包声明而不是继续用宿主 `@server/transport/ws-types`：该类型是「框架 WS 适配器」的形状，
 * 唯一被本包消费的部分就是下面四个成员（发送、关闭、就绪状态、缓冲水位），属于本模块的接口而不是宿主的
 * 领域概念——`/acp/ws` 端点、machine 注册连接、agent-node-bridge 的 socket 适配都长在本包内。声明为包内
 * 类型后，宿主 Elysia WS 适配器、machine 包自持的同名类型、测试用的假连接都是结构等价的实现，无需共享
 * 一个类型文件（machine 包在 1.3 已按同一理由自持，见 `packages/resources/machine/src/server/transport/ws-types.ts`）。
 *
 * 结构上限刻意保持最小：只声明本包读写的成员。宿主 `apps/server/src/transport/ws-types.ts` 的同名类型结构上
 * 满足本接口，因此宿主传入的连接对象无需转换即兼容；反向不成立（宿主类型多出的注释与约束不参与结构判断）。
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
