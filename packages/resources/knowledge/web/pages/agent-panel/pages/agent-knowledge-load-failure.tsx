/**
 * 知识库 web 面通用的「加载失败」持久态（§1.3(6)：error / retry 必须可区分、可恢复）。
 *
 * 三处调用点（创建表单的选项、切片列表、检索结果）此前只弹 toast 或仅写 `console.error`，
 * 失败后界面落回「暂无数据」空态——用户无从分辨「确实没有数据」与「请求失败」，也没有恢复入口。
 * 本组件把三处的共同口径收敛成一份：
 * - 一般失败 → `role="alert"` 的持久错误区 + 连接到**原请求**的重试按钮；
 * - 401/403（`request()` 已归一为 `UNAUTHORIZED`）→ 复用页面级无权限态且**不给重试按钮**，
 *   重试不会改变授权结果（判定与原因见 `agent-knowledge-access-denied.tsx`）。
 *
 * 判据（与同批 prod-view / sandbox 一致）：`error && 无数据` 才整区接管；已有数据之后的刷新失败
 * 保留旧数据，由调用方在各自的渲染分支里表达，本组件不持有数据。
 *
 * 为什么抽成组件：三处失败态的判据、`role="alert"` 契约与「无权限不给重试」必须逐字一致，
 * 各写一份迟早漂移；第二个真实用例已经出现，抽象不再提前。
 *
 * 2026-09-22 前端去重：块骨架改用库的 `EmptyState`（`tone="danger"` + `role="alert"` + 重试 action），
 * 配色与图标尺寸（原先散在本文件的 `#ef4444` / `#b91c1c` / `#94a3b8` 与 `text-[12px]` 等任意值类）
 * 交给组件；「读得出原因就多显示一行」的结构不变，仍是两行说明。
 */

import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { AlertCircle, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AgentKnowledgeAccessDenied, isKnowledgeAccessDenied } from "./agent-knowledge-access-denied";

interface KnowledgeLoadFailureProps {
  /** 失败原因：`unwrap` 抛出的 `ApiError`、原始异常，或后端错误信封（`{ code, message }`）。 */
  error: unknown;
  /** 失败区标题（各调用点用自己的字典键，便于区分同一页面上的多个失败区）。 */
  title: string;
  /** 重试回调：必须重新发起原请求，而不是只重置本地状态。 */
  onRetry: () => void;
  className?: string;
}

export function KnowledgeLoadFailure({ error, title, onRetry, className }: KnowledgeLoadFailureProps) {
  const { t } = useTranslation(NS.KNOWLEDGE);

  // 无权限：只解释原因、不给重试（与页面级无权限态共用同一判定与文案）。
  if (isKnowledgeAccessDenied(error)) return <AgentKnowledgeAccessDenied />;

  // 失败原因原样展示：服务端消息（如 `请求失败 (500)`）是排障上下文，不该只在 console 里。
  // 读不出原因时只显示标题、说明行退化为提示本身，不用占位文案冒充原因（`readErrorMessage` 的取舍）。
  const message = readErrorMessage(error);

  return (
    <EmptyState
      tone="danger"
      role="alert"
      className={className}
      icon={<AlertCircle />}
      title={title}
      description={
        message ? (
          <>
            {message}
            <br />
            {t("loadFailure.hint")}
          </>
        ) : (
          t("loadFailure.hint")
        )
      }
      action={{ label: t("actions.retry"), onClick: onRetry, icon: <RefreshCw /> }}
    />
  );
}

/**
 * 读取可展示的失败原因。
 *
 * 三条来源都必须认得：`unwrap` 抛出的 `ApiError`（Error 实例）、检索接口手检 `success` 时拿到的
 * 错误信封（普通对象，`code` + `message`，不是 Error 实例）、以及网络层异常。读不出消息时返回
 * `null`（只显示标题与重试），不用占位文案冒充原因。
 */
function readErrorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message.trim() || null;
  if (typeof error === "object" && error !== null && "message" in error) {
    const { message } = error as { message?: unknown };
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return null;
}
