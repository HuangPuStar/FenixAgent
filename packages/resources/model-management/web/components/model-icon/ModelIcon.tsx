import { ModelIcon as LobeModelIcon } from "@lobehub/icons";
import { memo, useMemo } from "react";
import { findModelIconEntry } from "./model-icon-map";

export interface ModelIconProps {
  /** 完整模型 ID，如 `gpt-4o-mini` / `claude-3-opus` */
  modelId: string | null | undefined;
  /** 图标尺寸（px），默认 16 */
  size?: number;
  /** 渲染变体：color 优先彩色，mono 单色品牌图标 */
  variant?: "color" | "mono";
  className?: string;
}

/**
 * 模型图标渲染组件。
 *
 * 渲染优先级：
 *   1. 本地对照表 `modelIconMap`（显式维护的常用模型映射）
 *   2. `@lobehub/icons` 内置 `ModelIcon` helper（400+ 关键字匹配兜底）
 *   3. 默认图标（helper 内部处理）
 *
 * 所有图标均来自本地安装的 `@lobehub/icons`，不依赖任何 CDN 资源。
 */
export const ModelIcon = memo(function ModelIcon({ modelId, size = 16, variant = "color", className }: ModelIconProps) {
  const entry = useMemo(() => findModelIconEntry(modelId), [modelId]);

  // 1. 本地对照表命中：variant=color 时优先彩色，缺失则回退到品牌单色
  if (entry) {
    const Component = variant === "color" ? (entry.Color ?? entry.Icon) : entry.Icon;
    return <Component size={size} className={className} />;
  }

  // 2. 兜底到 @lobehub/icons 内置 ModelIcon helper
  return (
    <LobeModelIcon
      model={modelId ?? undefined}
      size={size}
      type={variant === "mono" ? "mono" : "color"}
      className={className}
    />
  );
});
