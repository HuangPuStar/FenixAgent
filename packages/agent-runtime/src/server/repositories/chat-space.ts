import { chatSpace } from "@fenix/agent-runtime/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { getAgentRuntimeDatabase } from "../db";

/**
 * Chat 会话分组的持久化边界。
 *
 * 会话本体由 ACP 侧持有（`ses_*`），本层只维护「分组 → 会话 id 列表」这一平台侧偏好数据。
 *
 * **不变量与实现约束**：
 * 1. 读写一律带租户谓词（多用户隔离默认开启）：带实例的动作收 {@link ChatSpaceScope}（`instance_uid` +
 *    `user_id`），按分组 id 定位的查询收 {@link ChatSpaceUserInput}（`user_id`；门面另拿入参 `instanceUid`
 *    比对行上的 `instance_uid`）。
 * 2. `session_ids` 的增删一律是**单条 SQL**（jsonb `-` / `||`），不做「读数组、改、写回」：并发移动下
 *    读改写会丢更新，而「一个会话至多属于一个分组」正是靠这条原子性成立的。
 * 3. 移动（{@link IChatSpaceRepo.moveSessionToSpace}）整体在一个事务内：先摘除、后追加，且摘除覆盖同 scope
 *    的全部行，否则中途失败会留下「会话同时存在于两个分组」的可见中间态。取消归属
 *    （{@link IChatSpaceRepo.removeSessionFromScope}）使用同序 scope 锁与同一条摘除语句，避免等待期间漏摘新属主。
 * 4. 唯一索引 `(instance_uid, user_id, name)` 是重名的唯一裁决点。写方法因此返回
 *    {@link ChatSpaceWriteOutcome} 而不是抛领域错误：服务层不必认识 PG 错误码，也不必用「先查后写」的预检
 *    去换一个必然存在的竞态窗口。`id` 由调用方生成（`space_` + 32 位 hex），与实例 uid 同风格。
 */

/** 分组作用域：某个持久实例的属主用户。 */
export interface ChatSpaceScope {
  readonly instanceUid: string;
  readonly userId: string;
}

/** 按「分组 id + 属主」定位的入参（分组 id 是定位符，不带实例）。 */
export interface ChatSpaceUserInput {
  readonly spaceId: string;
  readonly userId: string;
}

/** Chat 会话分组的持久化记录。 */
export interface ChatSpaceRecord {
  id: string;
  name: string;
  userId: string;
  instanceUid: string;
  sessionIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 写操作结论：`missing` 表示目标分组不在本 scope 内（不存在或不属于该用户），`conflict` 表示唯一索引冲突。
 *
 * 两种都是可预期的持久化结果，而不是故障：把它们归一成结论，领域错误（404 / 409）由服务层命名，
 * 驱动错误码只留在本层。
 */
export type ChatSpaceWriteOutcome =
  | { readonly outcome: "written"; readonly space: ChatSpaceRecord }
  | { readonly outcome: "missing" }
  | { readonly outcome: "conflict" };

/** 四个写动作的入参与 {@link ChatSpaceScope} 的组合；用对象传参而非位置参数（相邻同型字符串易串位）。 */
export type ChatSpaceRenameInput = ChatSpaceScope & { readonly spaceId: string; readonly name: string };
export type ChatSpaceSessionInput = ChatSpaceScope & { readonly spaceId: string; readonly sessionId: string };
/** 取消归属的入参：只按 scope 与会话定位，不需要分组 id（会话本来就不该由调用方指出自己在哪个分组）。 */
export type ChatSpaceRemoveSessionInput = ChatSpaceScope & { readonly sessionId: string };

export interface IChatSpaceRepo {
  /** 本 scope 的全部分组；顺序即侧栏展示顺序（创建时间倒序，最近新建的在最前）。 */
  listByScope(scope: ChatSpaceScope): Promise<ChatSpaceRecord[]>;
  /**
   * 按 (分组 id, 属主) 定位分组。
   *
   * 签名里没有 `instance_uid`：调用方（门面）已用入参 `instanceUid` 做完实例授权，本查询只需要回答「这一行
   * 是否属于该用户、挂在哪个实例下」，比对交给门面。因此隔离谓词只有 `user_id`（id 是全局唯一的定位符，
   * 单独出现不足以定位一行）；其余方法都同时带 `user_id` 与 `instance_uid`。
   */
  findByIdForUser(input: ChatSpaceUserInput): Promise<ChatSpaceRecord | undefined>;
  /** 新增；同 scope 同名（唯一索引命中）时不写行并返回 `conflict`。 */
  insert(input: ChatSpaceScope & { readonly id: string; readonly name: string }): Promise<ChatSpaceWriteOutcome>;
  renameInScope(input: ChatSpaceRenameInput): Promise<ChatSpaceWriteOutcome>;
  /** 移入：同事务内先从本 scope 所有分组摘除该会话，再追加到目标分组。 */
  moveSessionToSpace(input: ChatSpaceSessionInput): Promise<ChatSpaceWriteOutcome>;
  /**
   * 取消归属：从本 scope 的**所有**分组里原子摘除该会话。
   *
   * 不按分组定位：调用方要表达的是「这个会话不再属于任何分组」，按分组定位会逼它先反查服务端归属——
   * 本地快照滞后于在途写入时，那个反查会指向旧分组，摘除落在不存在的行上（no-op 成功），
   * 用户的移动就被静默丢弃。谓词限定含该会话的行，与移入的摘除同口径：无关分组的 `updated_at`
   * 不被无端推进，无命中（本就不在任何分组）返回 `undefined`，仍是幂等成功。
   */
  removeSessionFromScope(input: ChatSpaceRemoveSessionInput): Promise<ChatSpaceRecord | undefined>;
}

/** jsonb 的 `$type` 只是编译期断言：运行期非数组（人工改库）按空集合处理，避免把标量当列表迭代。 */
function toRecord(row: typeof chatSpace.$inferSelect): ChatSpaceRecord {
  return {
    id: row.id,
    name: row.name,
    userId: row.userId,
    instanceUid: row.instanceUid,
    sessionIds: Array.isArray(row.sessionIds) ? row.sessionIds : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 作用域隔离谓词：本文件所有语句都必须拼上它。 */
function scopeConditions(scope: ChatSpaceScope) {
  return [eq(chatSpace.instanceUid, scope.instanceUid), eq(chatSpace.userId, scope.userId)];
}

/**
 * 「数组含该会话」谓词。
 *
 * 用参数化 JSON 数组做 `@>` 包含判断，而不是 `?` 操作符或字符串匹配：会话 id 是外部输入，拼进 SQL 文本
 * 会引入注入面，而字符串匹配会把 `{` `,` 等 jsonb 语法字符当普通字符比较。
 */
function containsSession(sessionId: string) {
  return sql`${chatSpace.sessionIds} @> ${JSON.stringify([sessionId])}::jsonb`;
}

/**
 * 唯一索引冲突判定：Drizzle 把驱动错误包在 `cause` 里，逐层下钻（同 `workflow-v2` / `sandbox` 的口径）。
 * 只认 PG 错误码 `23505`，不靠错误文案——文案会随驱动版本与语言环境变化。
 */
function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (candidate.code === "23505") return true;
  return isUniqueViolation(candidate.cause);
}

/** 从 `returning()` 的结果中取行（Drizzle 返回数组，未命中为空数组）。 */
function firstRow(rows: (typeof chatSpace.$inferSelect)[]): ChatSpaceWriteOutcome {
  const row = rows[0];
  return row ? { outcome: "written", space: toRecord(row) } : { outcome: "missing" };
}

class PgChatSpaceRepo implements IChatSpaceRepo {
  async listByScope(scope: ChatSpaceScope): Promise<ChatSpaceRecord[]> {
    const db = getAgentRuntimeDatabase();
    const rows = await db
      .select()
      .from(chatSpace)
      .where(and(...scopeConditions(scope)))
      // 返回顺序即侧栏展示顺序（`groupBySpace` 直接沿用）：新建的分组排在最上面，故按创建时间倒序；
      // 同毫秒创建的分组仍要有稳定顺序（刷新后列表不得跳动），故以 id 倒序兜底。
      .orderBy(desc(chatSpace.createdAt), desc(chatSpace.id));
    return rows.map(toRecord);
  }

  async findByIdForUser(input: ChatSpaceUserInput): Promise<ChatSpaceRecord | undefined> {
    const db = getAgentRuntimeDatabase();
    const [row] = await db
      .select()
      .from(chatSpace)
      .where(and(eq(chatSpace.id, input.spaceId), eq(chatSpace.userId, input.userId)))
      .limit(1);
    return row ? toRecord(row) : undefined;
  }

  async insert(input: ChatSpaceScope & { readonly id: string; readonly name: string }): Promise<ChatSpaceWriteOutcome> {
    const db = getAgentRuntimeDatabase();
    const rows = await db
      .insert(chatSpace)
      .values({ id: input.id, instanceUid: input.instanceUid, userId: input.userId, name: input.name })
      // `onConflictDoNothing` 而不是 try/catch：插入路径的重名由这一条语句原子裁决，无异常、无预检窗口。
      .onConflictDoNothing({ target: [chatSpace.instanceUid, chatSpace.userId, chatSpace.name] })
      .returning();
    const row = rows[0];
    return row ? { outcome: "written", space: toRecord(row) } : { outcome: "conflict" };
  }

  async renameInScope(input: ChatSpaceRenameInput): Promise<ChatSpaceWriteOutcome> {
    const db = getAgentRuntimeDatabase();
    try {
      const rows = await db
        .update(chatSpace)
        .set({ name: input.name, updatedAt: new Date() })
        .where(and(eq(chatSpace.id, input.spaceId), ...scopeConditions(input)))
        .returning();
      return firstRow(rows);
    } catch (error) {
      // UPDATE 没有 `onConflictDoNothing`，改名撞上同 scope 的既有分组只能从驱动错误里认出来；
      // 其余异常原样上抛，不把存储故障伪装成冲突。
      if (isUniqueViolation(error)) return { outcome: "conflict" };
      throw error;
    }
  }

  async moveSessionToSpace(input: ChatSpaceSessionInput): Promise<ChatSpaceWriteOutcome> {
    const db = getAgentRuntimeDatabase();
    return db.transaction(async (tx) => {
      // 先按 id 顺序锁住本 scope 全部分组：并发移动（A→B 与 B→A）若各自先锁目标行再互等就是死锁，
      // 统一先取同一批锁后，移动在本 scope 内串行，锁范围也只有该用户在这一实例下的分组行。
      const scoped = await tx
        .select({ id: chatSpace.id })
        .from(chatSpace)
        .where(and(...scopeConditions(input)))
        .orderBy(asc(chatSpace.id))
        .for("update");
      // 目标分组不在本 scope 时立刻返回，且此前没有任何写入：否则会先把会话从原分组摘掉、再发现目标不存在。
      if (!scoped.some((row) => row.id === input.spaceId)) return { outcome: "missing" };

      // 摘除：一条 UPDATE 覆盖本 scope 全部命中行，保证「至多属于一个分组」；谓词限定含该会话的行，
      // 无关分组的 updated_at 不被无端推进（也因此只锁真正要改的行）。
      await tx
        .update(chatSpace)
        .set({ sessionIds: sql`${chatSpace.sessionIds} - ${input.sessionId}::text`, updatedAt: new Date() })
        .where(and(...scopeConditions(input), containsSession(input.sessionId)));

      // 追加：jsonb 的 `||` 要求两侧同为数组或对象，标量拼接会报 invalid concatenation，故用
      // jsonb_build_array 包一层；摘除已在本事务内完成，这里不会产生重复项。
      const rows = await tx
        .update(chatSpace)
        .set({
          sessionIds: sql`${chatSpace.sessionIds} || jsonb_build_array(${input.sessionId}::text)`,
          updatedAt: new Date(),
        })
        .where(and(eq(chatSpace.id, input.spaceId), ...scopeConditions(input)))
        .returning();
      return firstRow(rows);
    });
  }

  async removeSessionFromScope(input: ChatSpaceRemoveSessionInput): Promise<ChatSpaceRecord | undefined> {
    const db = getAgentRuntimeDatabase();
    return db.transaction(async (tx) => {
      // 与移入使用同一锁顺序；否则 UPDATE 等待旧属主后重检谓词，会漏掉已移到另一行的会话。
      await tx
        .select({ id: chatSpace.id })
        .from(chatSpace)
        .where(and(...scopeConditions(input)))
        .orderBy(asc(chatSpace.id))
        .for("update");
      const rows = await tx
        .update(chatSpace)
        .set({ sessionIds: sql`${chatSpace.sessionIds} - ${input.sessionId}::text`, updatedAt: new Date() })
        .where(and(...scopeConditions(input), containsSession(input.sessionId)))
        .returning();
      const row = rows[0];
      return row ? toRecord(row) : undefined;
    });
  }
}

/** 分组仓储单例：进程内只有一个实现，替换点是 DB 句柄（用例经 `stubDb` 注入）。 */
export const chatSpaceRepo: IChatSpaceRepo = new PgChatSpaceRepo();
