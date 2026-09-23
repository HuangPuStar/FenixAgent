import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
import { cn } from "@fenix/ui-components/lib/cn";
import { Button } from "@fenix/ui-components/ui/button";
import { RotateCcw, Star } from "lucide-react";
import type { HTMLAttributes, KeyboardEvent, ReactNode } from "react";
import type { WorkflowVersionItem } from "../../../api/workflow-defs";

/**
 * 版本行：一处实现，三个消费方。
 *
 * 原先 `WorkflowVersions`（版本页卡片行）、`VersionPanel`（编辑器版本面板行）、`VersionIndicator`
 * （编辑器版本弹层行）各写一份，三份的 `v{version}` + latest 药丸 + 「设为 latest / 恢复到草稿」动作列
 * 是同一结构、同一交互语义——三个原实现的注释互相引用对方（「参考 VersionIndicator 同模式」），
 * 说明当时已认定是同一件事，只是没有落成共享件。
 *
 * 刻意分叉逐条留成 props（对应三处的真实差异，不做「看起来统一」的抹平）：
 * - `className` / `yamlClassName`：外壳。三处不是同一种盒子——版本页是卡片（边框 + hover 描边 +
 *   内衬都在这一个元素上），面板行是下边框分隔，弹层行是更紧的一行；hover 反馈也因此由调用方给
 *   （版本页是卡片描边，面板是行底色，弹层没有）。
 * - `meta`：时间元信息是三处最大的信息密度差异。版本页给相对时间（`relativeTime`），面板给绝对日期
 *   （`toLocaleString(i18n.language)`，取当前 locale），弹层不给（它的触发按钮上已写着状态与版本号）。
 *   内容归调用方，行只负责 muted 文字样式与图标间距。
 * - `active`：整行高亮 = 「当前正在预览这一版」，只有弹层有这一态，且与「展开了 YAML」（`expand.expanded`）
 *   不是同一件事，因此不能共用一个 prop。
 * - `expand`：行级展开原文只有版本页与面板有（弹层里没有展开位）。**给了才**把整行做成可聚焦控件。
 * - `onSetLatest` / `onRestore`：动作集合归调用方——弹层只对「当前预览的那一版」提供破坏性动作，
 *   版本页与面板对每一版都提供；`onSetLatest` 另外会因 `isLatest` 自动隐藏（已是 latest 无需再指）。
 * - `iconActions` / `extraActions`：弹层宽 280px，破坏性动作只有图标位，且多一个「预览」按钮。
 *
 * 视觉归一化（三处视觉体系本就不一致，取版本页那一份为准：它用 token 类与库原语表达，另两处是内联
 * 样式写死的十六进制值）：latest 药丸改走 `StatusBadge`（库内唯一的状态徽标实现），版本号与时间统一
 * 到 `text-xs` 刻度，动作按钮统一为 `ui/button` 的 `size="xs" | "icon-xs"` + `variant="outline"`，
 * 展开原文统一为一个 `<pre>`。
 */
const ROW_SHELL = "flex flex-wrap items-center gap-x-3 gap-y-1 text-xs";

/**
 * 可展开的行才需要指针与键盘焦点反馈。焦点环用 `ring-2`（标准刻度）——原先版本页写的是任意值
 * `ring-[3px]`（FCP-WEB-01），面板是 `#3b82f6` 内联 outline，两者都收进 `ui/button` 同款 ring 刻度。
 */
const ROW_INTERACTIVE =
  "cursor-pointer rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

/** 展开的原文块：跟随调用方给的外壳（`yamlClassName`），内衬与上限取版本页那一份的刻度。 */
const YAML_BLOCK =
  "bg-surface-2 border border-border-light rounded-md p-2.5 font-mono text-xs text-text-secondary max-h-72 overflow-auto m-0 whitespace-pre-wrap";

/**
 * 文案由调用方翻译后传入（沿用包内 `labels` / `messages` 惯例，同 prod-view 的
 * `prod-view-editor.tsx`）：三处读的不是同一族 key——版本页读 `versions.*`，面板与弹层读
 * `editor.vi_*`（文案不同：「设为 latest」/「设为最新」）。key 是翻译资源的引用，共享件自带 key
 * 等于替三个页面重指文案，超出收敛重复的范围。
 */
export interface VersionRowLabels {
  /** latest 药丸文案 */
  latest: string;
  /** 「设为 latest」按钮文案（同时作为 `title`） */
  setLatest: string;
  /** 「恢复到草稿」按钮文案（同时作为 `title`） */
  restoreToDraft: string;
}

export interface VersionRowProps {
  version: WorkflowVersionItem;
  isLatest: boolean;
  labels: VersionRowLabels;
  /** 时间元信息（可选）：相对时间 / 绝对日期由调用方决定，不给则不占位。图标若需要，由调用方自带尺寸类 */
  meta?: ReactNode;
  /** 当前预览态高亮（弹层专有） */
  active?: boolean;
  /** 行级展开原文：给了才把整行做成键盘可达的展开控件 */
  expand?: {
    expanded: boolean;
    yaml: string | null;
    /** 整行可访问名（调用方插值 version 后传入） */
    label: string;
    onToggle: () => void;
  };
  /** 「设为 latest」：不给则不渲染（弹层只在当前预览态提供）；`isLatest` 为真时同样不渲染 */
  onSetLatest?: () => void;
  /** 「恢复到草稿」：不给则不渲染（同上） */
  onRestore?: () => void;
  /** 动作列前置的额外动作（弹层的「预览」按钮） */
  extraActions?: ReactNode;
  /** 动作按钮用图标形态（窄容器没有文字位，可访问名由 `aria-label` 提供） */
  iconActions?: boolean;
  /** 行外壳：内衬、边框、hover 反馈归调用方 */
  className?: string;
  /** 展开原文的外壳（默认只补一个上间距）；面板的行内衬在内层，需要自带左右内衬 */
  yamlClassName?: string;
}

/**
 * 动作按钮：图标形态给 `aria-label`（文字位没有，可访问名不能只靠 `title` 悬停），
 * 文字形态由可见文字承载可访问名，`title` 两处都给。
 */
function VersionActionButton({
  icon,
  label,
  iconOnly,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  iconOnly?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size={iconOnly ? "icon-xs" : "xs"}
      variant="outline"
      title={label}
      aria-label={iconOnly ? label : undefined}
      onClick={onClick}
    >
      {icon}
      {!iconOnly && label}
    </Button>
  );
}

export function VersionRow({
  version,
  isLatest,
  labels,
  meta,
  active,
  expand,
  onSetLatest,
  onRestore,
  extraActions,
  iconActions,
  className,
  yamlClassName,
}: VersionRowProps) {
  /*
   * 整行点击 = 展开/收起该版本 YAML。这在库里没有等价的键盘入口（动作列只有「设为 latest /
   * 恢复到草稿」，都不做展开），所以整行必须自己是可聚焦控件：role="button" + tabIndex +
   * Enter/Space 键处理（Space 默认会滚动页面，需 preventDefault）。aria-expanded 暴露展开状态，
   * aria-label 给整行一个不含内部按钮文案的可访问名。
   * 弹层没有展开位，因此不给 `expand` 时整行保持普通容器语义——不自造一个点不动的按钮。
   */
  const expansion: HTMLAttributes<HTMLDivElement> = expand
    ? {
        role: "button",
        tabIndex: 0,
        "aria-expanded": expand.expanded,
        "aria-label": expand.label,
        onClick: expand.onToggle,
        onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
          // 后代隔离：动作列里是真实的 <button>，落在它们身上的 Enter/Space 属于按钮自身，必须原样
          // 冒泡给浏览器默认激活；这里抢过来既会 preventDefault 掉按钮的默认激活，又会让整行误展开。
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          expand.onToggle();
        },
      }
    : {};

  return (
    <>
      <div className={cn(ROW_SHELL, expand && ROW_INTERACTIVE, active && "bg-brand-subtle", className)} {...expansion}>
        <span className="font-mono font-semibold text-text-primary min-w-10">v{version.version}</span>
        {isLatest && <StatusBadge status="latest" tone="success" label={labels.latest} />}
        {meta !== undefined && <span className="inline-flex items-center gap-0.5 text-text-muted">{meta}</span>}
        {/* 动作列自成一体：整行是展开控件时，点按钮不应连带展开（弹层没有整行点击，多这一层也无害）。 */}
        <div className="ml-auto flex shrink-0 items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
          {extraActions}
          {!isLatest && onSetLatest && (
            <VersionActionButton
              icon={<Star />}
              label={labels.setLatest}
              iconOnly={iconActions}
              onClick={onSetLatest}
            />
          )}
          {onRestore && (
            <VersionActionButton
              icon={<RotateCcw />}
              label={labels.restoreToDraft}
              iconOnly={iconActions}
              onClick={onRestore}
            />
          )}
        </div>
      </div>

      {expand?.expanded && expand.yaml !== null && (
        <div className={cn("mt-2", yamlClassName)}>
          <pre className={YAML_BLOCK}>{expand.yaml}</pre>
        </div>
      )}
    </>
  );
}
