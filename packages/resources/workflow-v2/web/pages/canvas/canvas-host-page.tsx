// pages/canvas/canvas-host-page.tsx
// 画布宿主页：`/agent/workflow/$id/edit` 渲染的页面（设计 §6.2 的「画布宿主页」行）。
//
// 职责：① 探测上游就绪度（租户 App 绑定 + 平台空间）；② 拼 iframe URL 并挂载画布；③ 跑握手状态机
// （`use-canvas-handshake`：取 code → 兑换 → `token` 下发 → 续期 → 撤销）；④ 超时与失败的降级；
// ⑤ `navigate-out` 交宿主路由返回列表。
//
// 本页是**票据持有方**：票据在 `use-canvas-handshake` 的内存里，画布侧只拿到票据值；续期与撤销因此都在
// 宿主侧闭环（冻结 §7 为什么选 `token` 路径的理由）。
//
// 参数语义：路由的 `$id` 是 **上游 workflow ID**。它同时喂给三个地方——一次性 code 的 `workflowId`、
// 画布 URL 的 `workflow_id`、以及画布后续透传请求里显式带上的 `workflow_id`；三者与票据 `claims.wf`
// 必须逐字一致（冻结 §6/§7），所以这里**不做任何 id 转换**（服务端也没有「本地 id → 上游 id」的查询端点）。

import { cn } from "@fenix/ui-components/lib/cn";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useNavigate } from "@tanstack/react-router";
import { useRequest } from "ahooks";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { fetchOrgAppBinding, fetchPlatformAccount } from "../../api/canvas-session";
import { WORKFLOW_NS } from "../../i18n/namespace";
import { canvasAnnouncementKey, resolveCanvasUpstream, resolveCanvasViewState } from "./canvas-hosting-model";
import { buildCanvasFrameUrl, toCanvasLanguage } from "./canvas-protocol";
import { CanvasAnnouncement, CanvasStatusPanel } from "./canvas-status-views";
import { useCanvasHandshake } from "./use-canvas-handshake";

export interface WorkflowCanvasHostPageProps {
  /** 上游 workflow ID（宿主路由的 `$id`，见文件头）。 */
  readonly upstreamWorkflowId: string;
}

/** 画布 iframe 的 `sandbox`（设计 §5.3 逐字取值）。 */
const CANVAS_FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals";

/**
 * iframe 的宽度下限（= 上游画布文档的宽度下限）。
 *
 * 上游画布的根容器 `.coz-layout` 是**固定 1200px** 的三栏布局（左侧面板 + 画布 + 右侧属性面板），
 * 实测其在窄于该值时不会自适应收缩，而是让画布**文档本身**变宽（`documentElement.scrollWidth` 恒为
 * 1200）。若把 iframe 交给容器宽度（`w-full`），两级横向滚动会同时出现：iframe 内部一条（上游文档
 * 溢出）＋ 右面板被 iframe 右边缘裁掉。因此这里给 iframe 一个不小于上游下限的宽度，并让**容器**
 * 成为唯一一层横向滚动（`overflow-x-auto`）：画布按设计宽度渲染，页面自身不产生滚动条。
 *
 * 取值用主题间距刻度（`--spacing: 4px`，`min-w-300` = 1200px），不写任意值类（FCP-WEB-01）。
 */
const CANVAS_FRAME_MIN_WIDTH_CLASS = "min-w-300";

/**
 * `space-missing` 的自愈预算：**有界**自动重试的次数与间隔。
 *
 * 该状态的含义是「平台账号台账里还没有空间 id」——服务端读路径会按需引导（单飞 + 8s 预算），因此它通常
 * 只是几十秒内的过渡态。让用户为此手点「重试」是把一次性初始化成本转嫁给他，所以页面对这一种状态自己重试
 * 几次；次数固定、状态离开该分支即停止，恢复后无需刷新整页（成功即切到 iframe）。
 */
const SPACE_MISSING_AUTO_RETRY_LIMIT = 3;
const SPACE_MISSING_AUTO_RETRY_DELAY_MS = 2_500;

export function WorkflowCanvasHostPage({ upstreamWorkflowId }: WorkflowCanvasHostPageProps) {
  const { t, i18n } = useTranslation(WORKFLOW_NS);
  const navigate = useNavigate();

  // 两个控制台端点并行取；任一失败即 `probe-failed`（不把「取不到」当成「没绑定」，两者的引导不一样）。
  const { data, loading, error, refresh } = useRequest(async () => {
    const [binding, account] = await Promise.all([unwrap(fetchOrgAppBinding()), unwrap(fetchPlatformAccount())]);
    return { binding, account };
  });

  const upstream = resolveCanvasUpstream(
    loading ? { status: "pending" } : error || !data ? { status: "failed" } : { status: "loaded", ...data },
  );
  const frameUrl =
    upstream.state === "ready"
      ? buildCanvasFrameUrl({
          upstreamWorkflowId,
          platformSpaceId: upstream.platformSpaceId,
          language: toCanvasLanguage(i18n.language),
        })
      : null;

  const handleNavigateOut = useCallback(() => {
    void navigate({ to: "/agent/workflow" });
  }, [navigate]);
  const handshake = useCanvasHandshake({ upstreamWorkflowId, frameUrl, onNavigateOut: handleNavigateOut });
  const state = resolveCanvasViewState({
    upstream,
    phase: handshake.phase,
    retryable: handshake.retryable,
  });

  // 重试的语义分两层：上游探测失败 → 重查绑定；画布侧失败 → 复位握手并重挂载 iframe。两者的区别是
  // 「有没有 iframe 可恢复」，由上游状态直接决定，不需要给用户两个按钮。
  const handleRetry = useCallback(() => {
    if (upstream.state === "blocked") {
      refresh();
      return;
    }
    handshake.retry();
  }, [upstream.state, refresh, handshake.retry]);

  const showStatus = state.kind !== "frame" || state.phase !== "interactive";

  // `space-missing` 的有界自动重试（见常量处说明）。计数只在「成功进入画布」时复位：`refresh()` 会先把
  // 状态打成 loading，若把 loading 也当复位点，失败→重试→loading 就会变成无界循环。
  const blockedReason = state.kind === "blocked" ? state.reason : null;
  const spaceMissingRetries = useRef(0);
  useEffect(() => {
    if (state.kind === "frame") spaceMissingRetries.current = 0;
  }, [state.kind]);
  useEffect(() => {
    if (blockedReason !== "space-missing") return;
    if (spaceMissingRetries.current >= SPACE_MISSING_AUTO_RETRY_LIMIT) return;
    const timer = setTimeout(() => {
      spaceMissingRetries.current += 1;
      refresh();
    }, SPACE_MISSING_AUTO_RETRY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [blockedReason, refresh]);

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      <CanvasAnnouncement label={t(canvasAnnouncementKey(state))} />
      {state.kind === "frame" && frameUrl !== null ? (
        // 唯一一层横向滚动落在这里：iframe 有宽度下限（上游画布的固定三栏），窄视口下由本容器滚动，
        // 而不是让 iframe 内部再出一条横向滚动条（页面自身因此始终无横向滚动条）。
        <div className="relative min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
          <iframe
            ref={handshake.iframeRef}
            key={handshake.frameKey}
            src={frameUrl}
            title={t("canvas.frameTitle")}
            sandbox={CANVAS_FRAME_SANDBOX}
            referrerPolicy="no-referrer"
            // ready 之前盖着骨架：即使骨架被读屏跳过，指针事件也不该落到尚未握手的画布上。
            className={cn("h-full w-full border-0", CANVAS_FRAME_MIN_WIDTH_CLASS, showStatus && "pointer-events-none")}
          />
          {showStatus ? (
            <div className="absolute inset-0">
              <CanvasStatusPanel state={state} onRetry={handleRetry} />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <CanvasStatusPanel state={state} onRetry={handleRetry} />
        </div>
      )}
    </div>
  );
}
