import type * as Y from "yjs";
import type { NormalizedEvent } from "../schema";
import type { DocManager } from "../state";
import type { YjsBroadcaster } from "./broadcaster";
import type { ConnectionRegistry } from "./connection-registry";

/** relay 事件规范化与会话投影的宿主依赖。 */
export interface RelayEventHandlerDependencies {
  /** Agent 断开时废弃频道内存确认，区别于页面连接断开。 */
  invalidateRuntimeSession?: (rcsSessionId: string) => void;
  registry: ConnectionRegistry;
  broadcaster: YjsBroadcaster;
  docManager: DocManager;
  registerYjsDocListener: (ydoc: Y.Doc, docName: string, generation?: string) => void;
  reportError: (message: string, error: unknown) => void;
  /** 每次从 Agent 收到消息时更新实例活跃时间（宿主注入，内部过滤保活消息） */
  touchInstanceActivity: (instanceId: string, raw: Record<string, unknown>) => void;
  /** 安全诊断日志：只记录低基数 method/type，不得记录 payload 或会话标识。 */
  log?: (message: string) => void;
  /**
   * 旧投影路径处理后的旁路通知（新同步协议接线用）。
   *
   * 必须先完成 `processNormalizedEvent` 再调用；旧客户端行为不依赖本回调。实现方负责按连接过滤
   * trusted turnId 并自行捕获异步错误。
   */
  onNormalizedEvent?: (rcsSessionId: string, event: NormalizedEvent) => void;
}
