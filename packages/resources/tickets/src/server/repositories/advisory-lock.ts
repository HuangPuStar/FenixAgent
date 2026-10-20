/**
 * 工单模块的互斥原语：组织级/工单级的事务内咨询锁。
 *
 * 锁键只有本文件构造（`ticketsProjectLockKey` / `ticketsIssueLockKey`）：调用点各自拼字符串时，一处笔误
 * 就会让两段本该互斥的代码各持一把锁，而且不会报错。键名带 `fenix:tickets:` 命名空间前缀，避免与其它
 * 模块的锁键（plugin-market、model-gateway）在同一个 64 位哈希空间里无谓碰撞。
 *
 * **与设计方案 §9.2 的一处明确偏离（决策 D2）**：方案要求「advisory lock 由独立、受限连接持有、跨外部
 * 操作（约 15 秒的建仓库/建 Issue 调用）」。本批**不**跨外部调用持锁，理由是仓库侧拿不到第二条连接：
 * `DATABASE_URL` 只由宿主持有，包内无法自建受限连接池；而在共享业务连接池上把一条连接按外部调用的时长
 * 占住，正是方案同一句话里禁止的行为。等价保护由三件事共同给出：
 *
 * 1. **事务短**：`withTicketLock` 只覆盖「读改写」这一段，外部调用在事务之外（见 §6.1/§8.3 的步骤顺序）；
 * 2. **状态机持久化**：`ticket_operations` 的 `pending → dispatching` 条件更新让同一幂等键只有一个执行者，
 *    即使两段代码完全并发也只会创建一次远端对象（`ticket-operation-service.begin`）；
 * 3. **外部对象带 `message_id`**：远端正文内嵌 `msg_<uuid>`，T03 可据此回源核对「到底写过没有」。
 *
 * 换句话说：锁在这里只保证「同一组织的项目默认切换」与「同一幂等键的声明顺序」这两件**本地**事实，
 * 跨进程的写入去重靠状态机而不是靠锁。T03 接入恢复流程时必须复核这一点（§8.5 已登记）。
 */

import { runInTransaction } from "@fenix/platform-sdk/server";
import { sql } from "drizzle-orm";
import { getTicketsDatabase } from "../db";

/**
 * 组织级项目锁：开通、切换默认、暂停都按组织互斥。
 *
 * 覆盖的是「一个组织最多一条 active 默认项目」这条不变量（部分唯一索引是最后一道保险，不是第一道）：
 * 先清旧默认再置新默认的两条 UPDATE 必须整体串行，否则并发切换会各清各的、留下两条或零条默认。
 */
export function ticketsProjectLockKey(organizationId: string): string {
  return `fenix:tickets:project:${organizationId}`;
}

/**
 * 工单级锁：同一工单的编辑/评论串行化（T03/T04 使用，T02 先落地函数以免届时再添一把锁键）。
 *
 * 取值面不受 `issueNumber` 的解析影响：拼进键的永远是字符串，`hashtextextended` 再做一次稳定哈希。
 */
export function ticketsIssueLockKey(projectId: string, issueNumber: string): string {
  return `fenix:tickets:issue:${projectId}:${issueNumber}`;
}

/**
 * 在事务内取咨询锁并执行回调；锁随事务提交/回滚释放。
 *
 * `pg_advisory_xact_lock` 而不是会话级锁：事务结束即释放，连接归还池时不会留下未释放的锁——这也是本模块
 * 能安全偏离方案「独立受限连接持锁」的前提。`runInTransaction` 是 REQUIRED 语义，外层已开事务时直接加入，
 * 因此嵌在更大的事务里不会出现「锁在子事务上」的假互斥。
 */
export async function withTicketLock<T>(lockKey: string, run: () => Promise<T>): Promise<T> {
  return runInTransaction(async () => {
    await getTicketsDatabase().execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    return run();
  });
}
