import { Loader } from "lucide-react";

/**
 * 面板内的行内转圈：lucide `Loader` + 本包编辑器 CSS 的 `wf-spin` 动画（`pages/workflow/workflow.css`）。
 *
 * 为什么共享：这行写法此前在 `RunListPanel` / `TriggerPanel` / `VersionPanel` / `VersionIndicator` 四处
 * 逐字重复（`<Loader size={16} style={{ animation: "wf-spin 1s linear infinite", display: "inline-block" }} />`），
 * 尺寸 16 / 14 各写各的；收在这里后「面板内联转圈」只有一处定义。
 *
 * 为什么不用 `@fenix/ui-components/ui/spinner`：库的 `Spinner` 是圆环 + 可选文案的容器（`variant` 还给
 * 居中外壳），而这里的四处是嵌在面板文案流里的小图标——14~16px、跟随所在行的文字色、动画由 `wf-spin`
 * 驱动。换库原语会连尺寸（14/16 → `sm` 的 24）与环色（`text-brand`）一起改掉，那是视觉归一化而不是去重，
 * 属于编辑器整体改造的议题，不在本批（只去重、不改视觉）范围内。
 */
const INLINE_SPIN_STYLE = { animation: "wf-spin 1s linear infinite", display: "inline-block" } as const;

export function InlineLoader({ size = 16 }: { size?: number }) {
  return <Loader size={size} style={INLINE_SPIN_STYLE} />;
}
