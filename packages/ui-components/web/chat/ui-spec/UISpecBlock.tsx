/**
 * `ui-spec` 围栏的块级入口：容器 / 骨架 / 原文 / 组件树四态切换，含降级与懒加载边界。
 *
 * 依赖分层（§5.2）：`plugins → UISpecBlock → parse/spec`；`UISpecBlock →(lazy)→ UISpecView → registry`。
 * 本文件因此是**静态模块**，两条纪律不能破：
 *
 * 1. **不静态 import streamdown 的值导出**。`plugins.ts` 被 `message.tsx` 静态引，静态值导入会把整个
 *    streamdown 放进首屏静态图，破坏 `message.tsx` 既有的 `lazy(() => import("streamdown"))` 边界
 *    （§5.2 懒加载边界）。容器/骨架经下面的动态模块边界加载。
 * 2. **错误边界落在本文件**（而不是可 lazy 的 `UISpecView`）：边界必须与被包裹的懒模块同处静态图，
 *    否则「动态 import 失败」这类错误没有就地兜底，会穿到宿主的消息级边界上。
 *
 * 降级矩阵（§1.5）逐条落实：
 * - L0 限额：`code` 超 `maxCodeChars` → 不 parse、不挂骨架，整块原文 pre（不截断成貌似完整的 UI）；
 * - L0 流式：**只有本次挂载内观察到该 `code` 的增量**且 `isIncomplete` 时才挂官方骨架（§3.1 规则 1），
 *   且骨架可见期间**不解析**正文（此时解析结果不会被展示，还会随每个增量块重复整块解析）；
 * - L0 未确认活跃：首次挂载、历史、状态未知、`isIncomplete` 转真但正文没变 → 解析当前正文，
 *   完整合法就正常渲染，半截就原文（不补括号猜内容，不永久等骨架）；
 * - L0 超时：骨架下 `code` 连续 3s 不变 → 退回原文，新 `code` 到来可重新进骨架（§3.1 规则 3）；
 * - L1/L2：解析失败（json / structure / limits）→ 原文；版本不受支持 → 占位提示 + 原文；
 * - L4：组件 render 或懒加载抛错 → 块级 ErrorBoundary 占位 + 原文，`code` 变化即重置，不锁死。
 *
 * 安全（§1.7）：本文件只把 `code` 当文本渲染，不解析 HTML、不构造 URL、不发请求；降级观测只记稳定
 * reason 与去重键，不记录 code / props / 原始异常文本（`docs/arch/19-yjs-chat-streaming.md` 禁止正文进日志）。
 */

import { Component, lazy, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CustomRendererProps } from "streamdown";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { parseUISpec } from "./parse";
import { UI_SPEC_LIMITS } from "./spec";
import "./UISpecBlock.css";

/** 骨架无新增量时的兜底时长（§3.1 规则 3）：仅是 UI 防卡死，不代表服务端 turn 已结束。 */
const SKELETON_STALL_MS = 3_000;

/** 挂载内的流式记忆（§3.1）：只认本次挂载里观察到的正文增量，并去重已上报的降级原因。 */
interface BlockMemory {
  /** 上一次渲染看到的正文：用来识别「本次挂载内的增量」。 */
  code: string;
  /** 本次挂载内是否观察到过正文变化（`isIncomplete` 转假即清除）。 */
  sawIncrement: boolean;
  /** 已上报的 (输入, reason)：同一对只上报一次（§1.5 降级可观测）。 */
  reported: { code: string; reason: string } | null;
}

interface UISpecBlockFrameProps {
  language: string;
  isIncomplete: boolean;
  /** 渲染态：`ready` = 正文是自有组件（伴随表据此关闭「代码块外壳」）；缺省 = 骨架 / 降级态。 */
  state?: "ready";
  /** 正文；缺省时渲染官方骨架（骨架同样来自动态模块，本文件静态引不到它）。 */
  children?: ReactNode;
}

/**
 * streamdown 官方容器 / 标题 / 骨架的动态模块边界。
 *
 * 骨架复用官方导出而不是自研（§1.6）：`UISpecBlock.css` 只对自有 `data-slot` 下的官方骨架补
 * 未生成的类串所对应的 token 规则，不重写它、不引 `CodeBlock`（那会连带拉高亮与行号）。
 *
 * 骨架同时承担两处：流式待定态（`children` 缺省）与懒加载 `UISpecView` 的 Suspense 兜底（§5.2
 * 「Suspense 内用官方骨架」）——两者都在容器内部，容器本身不闪断。
 */
const LazyBlockFrame = lazy(async () => {
  const { CodeBlockContainer, CodeBlockHeader, CodeBlockSkeleton } = await import("streamdown");

  function UISpecSkeleton() {
    return (
      <div data-slot="ui-spec-skeleton">
        <CodeBlockSkeleton />
      </div>
    );
  }

  function UISpecBlockFrame({ language, isIncomplete, state, children }: UISpecBlockFrameProps) {
    return (
      <CodeBlockContainer
        data-slot="ui-spec-block"
        data-ui-spec-state={state}
        language={language}
        isIncomplete={isIncomplete}
      >
        <CodeBlockHeader language={language} />
        <Suspense fallback={<UISpecSkeleton />}>{children ?? <UISpecSkeleton />}</Suspense>
      </CodeBlockContainer>
    );
  }

  return { default: UISpecBlockFrame };
});

const LazyUISpecView = lazy(() => import("./UISpecView").then((module) => ({ default: module.UISpecView })));

/** 原文兜底：不截断、不解释、保持可复制；容器已 `padding: 0`，pre 的外边距由伴随表归零。 */
function UISpecRawCode({ code, notice }: { code: string; notice?: string }) {
  return (
    <div data-slot="ui-spec-raw" className="flex min-w-0 flex-col gap-2">
      {notice ? <span className="text-xs text-muted-foreground">{notice}</span> : null}
      <pre className="w-full">
        <code>{code}</code>
      </pre>
    </div>
  );
}

interface UISpecBlockBoundaryProps {
  /** 重置键：`code` 变化即允许重试，崩溃不锁死（§1.5 L4）。 */
  resetKey: string;
  fallback: ReactNode;
  children?: ReactNode;
}

/**
 * 块级错误边界：兜住容器/骨架模块加载失败、`UISpecView` 懒加载失败与组件 render 抛错。
 *
 * 不复用 `ui/error-fallback`：那是面板/整屏级降级 UI（居中 + 重试按钮 + `flex-1`），而这里要求
 * 「占位 + 原文」且不引入任何交互能力（§1.5 L4）。
 */
class UISpecBlockBoundary extends Component<UISpecBlockBoundaryProps, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidUpdate(previous: UISpecBlockBoundaryProps) {
    if (this.state.hasError && previous.resetKey !== this.props.resetKey) this.setState({ hasError: false });
  }

  componentDidCatch() {
    // 只报稳定标记：异常对象可能携带 Spec 正文或 zod issue 文本，按 §1.5「降级可观测」口径不入日志。
    console.warn("[ui-spec] block render failed");
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

export function UISpecBlock({ code, isIncomplete, language }: CustomRendererProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);

  /**
   * 挂载内的记账（渲染期同步更新，非 state）：
   * - `code` / `sawIncrement`：§3.1 规则 1/2 的增量标记 —— 首次挂载、历史、状态未知一律没有标记，
   *   只有本次挂载里真的看到过正文变化才允许骨架；候选失活（`isIncomplete` 转假）即清除。
   * - `reported`：降级原因去重（§1.5「降级可观测」），同一 (输入, reason) 只上报一次。
   *
   * 增量标记必须是**本次渲染内同步可见**的（所以放 ref 而不是 state，也不用渲染期 setState）：
   * 骨架可见时不允许解析正文（§1.5 L0 流式「官方 CodeBlockSkeleton，不解析」），而「骨架是否可见」
   * 决定了 `parsed` 的取值。走渲染期 setState 的话，被丢弃的那一趟仍会执行一次整块解析 —— 正是要避免的。
   * 两个分支都幂等（更新后条件不再成立），StrictMode 双渲染下结果一致。
   */
  const memoryRef = useRef<BlockMemory>({ code, sawIncrement: false, reported: null });
  const memory = memoryRef.current;
  if (memory.code !== code) {
    memory.code = code;
    memory.sawIncrement = true;
  } else if (!isIncomplete) {
    memory.sawIncrement = false;
  }

  /** 已经超时的那一份 code（§3.1 规则 3）：到点后骨架退回原文，直到新 code 到来才允许重新进骨架。 */
  const [stalledCode, setStalledCode] = useState<string | null>(null);

  // L0 限额优先于一切；其次骨架可见时**不解析**：此刻解析结果不会被展示，且会随每个增量块重复整块解析。
  const overLimit = code.length > UI_SPEC_LIMITS.maxCodeChars;
  const skeletonVisible = !overLimit && isIncomplete && memory.sawIncrement && stalledCode !== code;
  const parsed = useMemo(
    () => (overLimit || skeletonVisible ? null : parseUISpec(code)),
    [code, overLimit, skeletonVisible],
  );

  // 骨架下 3s 无新增量即退回原文（§3.1 规则 3）；此计时仅是 UI 防卡死，不代表服务端 turn 已结束。
  // `code` 在这里同时是重启键与入参：新 code 让「连续不变」的窗口重新计时，超时的标记因此按 code 记。
  useEffect(() => {
    if (!skeletonVisible) return;
    const timer = setTimeout(() => setStalledCode(code), SKELETON_STALL_MS);
    return () => clearTimeout(timer);
  }, [skeletonVisible, code]);

  // 降级可观测（§1.5）：只报稳定 reason，按 (输入, reason) 去重，effect 内上报（渲染期不反复 warn）。
  useEffect(() => {
    if (parsed?.status !== "degraded") return;
    const reported = memoryRef.current.reported;
    if (reported?.code === code && reported.reason === parsed.reason) return;
    memoryRef.current.reported = { code, reason: parsed.reason };
    console.warn("[ui-spec] degraded:", parsed.reason);
  }, [code, parsed]);

  let body: ReactNode;
  // 组件态标记：只有「正文渲染为自有组件」才关掉代码块外壳（见 UISpecBlock.css），其余态保持代码块外观。
  let componentReady = false;
  if (overLimit) {
    body = <UISpecRawCode code={code} />;
  } else if (parsed?.status === "ok") {
    body = <LazyUISpecView spec={parsed.spec} />;
    componentReady = true;
  } else if (parsed?.status === "degraded" && parsed.reason === "version") {
    // 版本占位带原文里的实际版本号：对「过新」与「过旧」都不谎称方向（§1.5 L2）。
    body = (
      <UISpecRawCode code={code} notice={t("chat.components.uiSpec.unsupportedVersion", { version: parsed.version })} />
    );
  } else {
    body = <UISpecRawCode code={code} />;
  }

  return (
    <UISpecBlockBoundary
      resetKey={code}
      fallback={
        // 容器模块本身可能是崩掉的那一环，此时只能给不带官方容器的朴素呈现（§1.5 L4）。
        <div data-slot="ui-spec-block" className="min-w-0">
          <UISpecRawCode code={code} notice={t("chat.components.uiSpec.renderFailed")} />
        </div>
      }
    >
      <Suspense fallback={<div data-slot="ui-spec-block" />}>
        <LazyBlockFrame isIncomplete={isIncomplete} language={language} state={componentReady ? "ready" : undefined}>
          {skeletonVisible ? undefined : body}
        </LazyBlockFrame>
      </Suspense>
    </UISpecBlockBoundary>
  );
}
