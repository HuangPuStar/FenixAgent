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
