import type * as Y from "yjs";
import { getSessionInfo } from "../state/chat-writer";
import type { SessionChannelDependencies, SessionConnection } from "./session-connection";
import { CommandExecutionError } from "./types";

interface ConfirmedProjection {
  chat: Y.Doc;
  continuity: object;
  userId: string;
  agentId: string;
  instanceId: string;
  runtimeIdentity: string;
  sessionId: string;
}

/** 同一运行代次内的刷新凭据；仅随内存投影存活，不从持久快照恢复确认。 */
export class SessionRestoration {
  private readonly confirmed = new WeakMap<Y.Doc, ConfirmedProjection>();

  constructor(private readonly dependencies: SessionChannelDependencies) {}

  /** 只在 Agent 已确认加载或创建后保存当前投影的运行身份。 */
  remember(connection: SessionConnection, sessionId: string): void {
    const session = this.dependencies.docManager.getSessionYdoc(connection.rcsSessionId);
    const chat = this.dependencies.docManager.getChatYdoc(connection.rcsSessionId);
    const continuity = connection.getSessionContinuity?.();
    if (!session || !chat || !connection.runtimeIdentity || !continuity) return;
    this.confirmed.set(session, {
      chat,
      continuity,
      userId: connection.userId,
      agentId: connection.agentId,
      instanceId: connection.instanceId,
      runtimeIdentity: connection.runtimeIdentity,
      sessionId,
    });
  }

  /** Agent 断开使内存确认失效，即使外围 relay 尚未关闭。 */
  forget(rcsSessionId: string): void {
    const doc = this.dependencies.docManager.getSessionYdoc(rcsSessionId);
    if (doc) this.confirmed.delete(doc);
  }

  /** 同一已确认运行与投影只恢复绑定；其他目标仍换代并请求 Agent 加载。 */
  async prepareLoad(
    connection: SessionConnection,
    sessionId: unknown,
    assertCurrent: () => void,
    activeConfirmed: boolean,
  ): Promise<boolean> {
    if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 256) {
      throw new CommandExecutionError("ACTION.INVALID_STATE");
    }
    if (activeConfirmed && connection.acpSessionId === sessionId && connection.sessionLoaded) return false;

    const session = this.dependencies.docManager.getSessionYdoc(connection.rcsSessionId);
    const proof = session ? this.confirmed.get(session) : undefined;
    if (
      session &&
      proof &&
      connection.runtimeIdentity &&
      proof.runtimeIdentity === connection.runtimeIdentity &&
      proof.continuity === connection.getSessionContinuity?.() &&
      proof.userId === connection.userId &&
      proof.agentId === connection.agentId &&
      proof.instanceId === connection.instanceId &&
      proof.sessionId === sessionId &&
      connection.acpSessionId === sessionId &&
      getSessionInfo(session).get("sessionId") === sessionId &&
      proof.chat === this.dependencies.docManager.getChatYdoc(connection.rcsSessionId)
    ) {
      connection.acpSessionId = sessionId;
      connection.sessionLoaded = true;
      this.dependencies.syncSessionId(connection, sessionId);
      return false;
    }

    // 缓存本身不能证明新 runtime 已加载会话；未命中当前运行的确认时仍须等待回执。
    const projection = await this.dependencies.docManager.replaceProjection(connection.rcsSessionId, sessionId);
    assertCurrent();
    this.dependencies.replaceProjection(projection);
    return true;
  }
}
