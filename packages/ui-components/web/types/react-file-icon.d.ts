/**
 * `react-file-icon` 第三方类型垫片。
 *
 * 上游包（1.6.0）只发布 JS，也没有 `@types/react-file-icon`；源宿主在 `apps/web/src/types/` 下自行声明。
 * 跨包引用不能依赖宿主的声明文件（引用它会把本包耦合回 `apps/web`，且消费方未必存在该文件），
 * 因此本包保留一份等价的模块声明，保证 `web/components/file-icon-helper.tsx` 在不放宽类型的前提下通过检查。
 *
 * 已知限制：声明内容需与上游包的 props 集合手工保持一致，上游新增 props 时不会自动同步。
 * 移除条件：`react-file-icon` 自带类型，或社区发布 `@types/react-file-icon`。
 */
declare module "react-file-icon" {
  import type { FC, SVGProps } from "react";

  type GlyphType =
    | "3d"
    | "acrobat"
    | "android"
    | "audio"
    | "binary"
    | "code"
    | "code2"
    | "compressed"
    | "document"
    | "drive"
    | "font"
    | "image"
    | "presentation"
    | "settings"
    | "spreadsheet"
    | "vector"
    | "video";

  interface FileIconProps extends SVGProps<SVGSVGElement> {
    /** 图标背景色 */
    color?: string;
    /** 标签显示的文本（扩展名） */
    extension?: string;
    /** 是否显示折角 */
    fold?: boolean;
    /** 折角颜色 */
    foldColor?: string;
    /** 类型 glyph 颜色 */
    glyphColor?: string;
    /** 页面渐变颜色 */
    gradientColor?: string;
    /** 页面渐变不透明度 */
    gradientOpacity?: number;
    /** 标签背景色 */
    labelColor?: string;
    /** 标签文字颜色 */
    labelTextColor?: string;
    /** 标签是否大写 */
    labelUppercase?: boolean;
    /** 圆角半径 */
    radius?: number;
    /** 文件类型 glyph */
    type?: GlyphType;
  }

  const FileIcon: FC<FileIconProps>;

  type DefaultStyle = Partial<FileIconProps>;

  /** 内建扩展名 → 默认样式映射 */
  const defaultStyles: Record<string, DefaultStyle>;

  export { type DefaultStyle, defaultStyles, FileIcon, type FileIconProps, type GlyphType };
}
