/**
 * use-chat-spaces.ts — 会话分组（Chat Space）数据层
 *
 * 分组是持久 Agent Instance 的附属偏好：列表按实例取（`instanceUid`），变更（新建 / 重命名 / 移入 / 移出）
 * 由后端在 `chat_space` 表上编排，前端只做「取数 → 变更 → 重取」，不复制归属与重名等领域规则。四个变更动作
 * 都把当前 `instanceUid` 一并发出（它是服务端的权威作用域，分组 id 只在该实例内解析），故实例未就绪时直接
 * 抛错而不是发一个作用域不明的请求。
 *
 * 三条冻结契约（消费方按此接线）：
 * 1. `instanceUid` 为空即「还没有实例可谈」——不发请求，返回空列表且 `spacesLoaded=false`；调用方据此区分
 *    「尚未加载」与「加载完成但确实没有分组」。
 * 2. 列表随 `instanceUid` 变化重取；数据连同它所属的实例 uid 一起存放，因为切实例的瞬间 `data` 里还是上一个
 *    实例的结果，直接透出会把 A 实例的分组画到 B 实例上。
 * 3. 变更失败向调用方原样抛出（`unwrap` 归一出的 `ApiError`），成功则重取列表。列表自身失败经
 *    `spacesError` 透出（`console.error` 保留诊断上下文），消费方据此给可重试提示——**不得静默降级成
 *    时间分组**（前端规范 §3.4 / §5.8：失败不得映射成 empty 或成功）。
 */

import { type ApiResponse, unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { useCallback, useRef, useState } from "react";
import { type ChatSpaceSummary, chatSpaceApi } from "../api/chat-spaces";

/**
 * 实例未就绪时的接线错误：动作不携带作用域就没有意义，抛出去让调用方修正接线，
 * 而不是静默发一个作用域不明的请求。
 *
 * 消息面向开发者诊断（英文、技术描述）：它会经 `useSpaceActionRunner` 的 `{{message}}` 槽位进入提示，
 * 写中文用户文案会在英文界面下露出半截中文。
 */
function requireInstanceUid(uid: string | null, action: string): string {
  if (!uid) throw new Error(`chat space ${action} requires an instanceUid (wiring error)`);
  return uid;
}

/** `useChatSpaces` 的返回面（冻结契约：字段名与签名由消费方依赖，不得改名或增删） */
export interface UseChatSpacesResult {
  /** 当前实例下的分组；`instanceUid` 缺失或该实例的列表尚未取到时为空数组 */
  spaces: readonly ChatSpaceSummary[];
  /** 当前实例的分组是否已取到（把「未加载」与「确实没有分组」分开） */
  spacesLoaded: boolean;
  /** 当前实例的分组列表是否加载失败（消费方据此给可重试提示，而不是退回时间分组当作没这回事） */
  spacesError: boolean;
  /** 重取当前实例的分组列表（失败提示里的重试入口） */
  refreshSpaces: () => void;
  createSpace: (name: string) => Promise<void>;
  renameSpace: (spaceId: string, name: string) => Promise<void>;
  assignSession: (spaceId: string, sessionId: string) => Promise<void>;
  unassignSession: (sessionId: string) => Promise<void>;
}

/** 列表状态：数据与它所属的实例 uid 同存，派生时据此判定是否属于当前实例 */
interface ChatSpaceListState {
  instanceUid: string | null;
  spaces: readonly ChatSpaceSummary[];
}

/** 空态（含「实例未就绪」）：`instanceUid: null` 与入参为空时的 uid 相等，派生结果即空列表 + 未加载 */
const EMPTY_LIST: ChatSpaceListState = { instanceUid: null, spaces: [] };

/** 透出用的空列表：稳定引用，避免每次渲染给出新数组让消费方的回调依赖无谓失效 */
const NO_SPACES: readonly ChatSpaceSummary[] = [];

/**
 * 订阅某实例下的会话分组，并暴露四个变更动作。
 *
 * @param params.instanceUid 当前持久 Agent Instance；空值（未选实例 / 无实例）时不发请求
 */
export function useChatSpaces({ instanceUid }: { instanceUid: string | null | undefined }): UseChatSpacesResult {
  const uid = instanceUid ?? null;
  // 失败态连同它所属的实例 uid 一起存：请求失败与实例切换可能交叉，只存一个布尔会让 B 实例的加载中
  // 继承 A 实例的失败提示。
  const [loadFailure, setLoadFailure] = useState<{ instanceUid: string; error: unknown } | null>(null);

  const { data, refresh } = useRequest(
    async (): Promise<ChatSpaceListState> => {
      // 没有实例就没有可查范围：不发请求，返回空态（契约：spaces 为空、spacesLoaded 为 false）
      if (!uid) return EMPTY_LIST;
      // request() 失败不 throw，unwrap 把 { success: false } 归一成 ApiError
      const payload = await unwrap(chatSpaceApi.list({ instanceUid: uid }));
      return { instanceUid: uid, spaces: payload.spaces ?? [] };
    },
    {
      // 切换实例即重取；ahooks 用请求序号丢弃被取代的旧响应，实例切回时不会被迟到的响应覆盖
      refreshDeps: [uid],
      onSuccess: () => setLoadFailure(null),
      onError: (error: unknown) => {
        // 两条出口缺一不可：console.error 承载诊断上下文，setLoadFailure 让 UI 能给出可重试提示
        console.error("[useChatSpaces] 加载会话分组失败", { instanceUid: uid, error });
        if (uid) setLoadFailure({ instanceUid: uid, error });
      },
    },
  );

  // 归属判定：只有「数据属于当前实例」时才透出，否则落空态
  const currentList = uid !== null && data?.instanceUid === uid ? data : null;
  const spaces = currentList ? currentList.spaces : NO_SPACES;
  const spacesLoaded = currentList !== null;
  const spacesError = loadFailure !== null && loadFailure.instanceUid === uid;

  /**
   * 变更收口：成功后重取列表，失败留诊断上下文后原样抛出（不吞错，调用方才能提示与重试）。
   *
   * **为什么重取而不是本地合并**：移入 / 移出会同时改到另一条分组行（一个会话至多属于一个分组，由后端在
   * 同一事务内原子摘除保证），本地合并要把这条领域规则复制一份才能算出同样的结果；重取一次即得权威状态。
   *
   * 重取**不阻塞**调用方：`refresh()` 本就是 fire-and-forget 语义，调用方 resolve 只表示变更已落库，列表在
   * 下一次渲染跟上；而 `refreshAsync()` 的 promise 在被更新的请求取代时永不落定，await 它会让调用方永久挂起。
   */
  // 同一实例的写按用户发起顺序发送，避免网络调度把最后一次移动反转；失败不阻塞后续写。
  const mutations = useRef(new Map<string, Promise<void>>());
  const runMutation = useCallback(
    (action: () => Promise<ApiResponse<unknown>>): Promise<void> => {
      const key = uid ?? "";
      const execute = async () => {
        try {
          await unwrap(action());
        } catch (error) {
          console.error("[useChatSpaces] 会话分组变更失败", error);
          throw error;
        }
        refresh();
      };
      const previous = mutations.current.get(key);
      const result = previous ? previous.then(execute, execute) : execute();
      mutations.current.set(key, result);
      const release = () => {
        if (mutations.current.get(key) === result) mutations.current.delete(key);
      };
      void result.then(release, release);
      return result;
    },
    [refresh, uid],
  );

  const createSpace = useCallback(
    async (name: string): Promise<void> => {
      // 没有实例就没有归属对象：这是调用方的接线错误，静默成功会让 UI 显示一个并不存在的分组
      await runMutation(() => chatSpaceApi.create({ instanceUid: requireInstanceUid(uid, "create"), name }));
    },
    [runMutation, uid],
  );

  const renameSpace = useCallback(
    async (spaceId: string, name: string): Promise<void> => {
      await runMutation(() =>
        chatSpaceApi.rename({ id: spaceId, instanceUid: requireInstanceUid(uid, "rename") }, { name }),
      );
    },
    [runMutation, uid],
  );

  const assignSession = useCallback(
    async (spaceId: string, sessionId: string): Promise<void> => {
      await runMutation(() =>
        chatSpaceApi.assign({ id: spaceId, sessionId, instanceUid: requireInstanceUid(uid, "assign") }),
      );
    },
    [runMutation, uid],
  );

  const unassignSession = useCallback(
    async (sessionId: string): Promise<void> => {
      // 不需要本地反查归属：DELETE 的摘除范围由服务端按 scope 决定。曾经由调用方反查分组 id 的那版
      // 会被滞后快照骗到旧分组（刚移入的新分组还没回到快照里），摘除落在空行上、用户的移出被静默丢弃。
      await runMutation(() => chatSpaceApi.unassign({ sessionId, instanceUid: requireInstanceUid(uid, "unassign") }));
    },
    [runMutation, uid],
  );

  return {
    spaces,
    spacesLoaded,
    spacesError,
    refreshSpaces: refresh,
    createSpace,
    renameSpace,
    assignSession,
    unassignSession,
  };
}
