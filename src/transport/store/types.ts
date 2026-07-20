/**
 * TransportStore 抽象接口，统一单节点（内存 Map）和多节点（Redis）的状态存储操作。
 *
 * 所有方法均为异步，子类可选使用 sync 实现（MemoryStore）或 async 实现（RedisStore）。
 */
export interface TransportStore {
  /** 设置 instance → relay socketId 映射（跨节点可见 relay 状态） */
  setRelaySocket(instanceId: string, socketId: string): Promise<void>;
  /** 获取 instance 对应的 relay socketId */
  getRelaySocket(instanceId: string): Promise<string | null>;
  /** 删除 instance → relay socketId 映射 */
  delRelaySocket(instanceId: string): Promise<void>;

  /** 设置 machine → socketId 映射（跨节点可见 machine 状态） */
  setMachineSocket(machineId: string, socketId: string): Promise<void>;
  /** 获取 machine 对应的 socketId */
  getMachineSocket(machineId: string): Promise<string | null>;
  /** 删除 machine → socketId 映射 */
  delMachineSocket(machineId: string): Promise<void>;

  /** 发布消息到指定频道（Pub/Sub） */
  publish(channel: string, message: string): Promise<void>;
  /** 订阅指定频道，返回取消订阅的函数 */
  subscribe(channel: string, handler: (message: string) => void): Promise<() => void>;

  /** 健康检查：Redis 返回 PING 结果，MemoryStore 始终返回 true */
  healthCheck(): Promise<boolean>;
  /** 关闭并释放所有资源（Redis 连接等） */
  close(): Promise<void>;
}
