import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  cn,
  Input,
  Progress,
  StatusBadge,
  useTheme,
} from "@fenix/ui-components";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../i18n";

/**
 * Design Tokens 分区：useTheme 与包内设计 token 抽样。
 *
 * 本分区是层级导航的第一层：token 是其余所有分区的视觉基底，因此排在 Base UI 之前，
 * 用示例展示「一处 token 改动如何同时作用到按钮、徽标、进度与输入框」。
 *
 * useTheme 必须在包的 ThemeProvider 内调用；demo 在根部（demo/providers.tsx）挂载了
 * ThemeProvider，本节所有组件共享同一份上下文，Provider 之外调用会直接抛错。
 *
 * 全局强制亮色：ThemeProvider 不再提供切换能力（不读 localStorage、不监听
 * prefers-color-scheme、不写 .dark 类），`theme` / `resolvedTheme` 因此恒为 "light"，
 * 本节也相应地不再有主题切换入口。
 *
 * 深色只剩「显式作用域」一条路径：两个主题入口（宿主 apps/web/src/index.css 与包内
 * web/styles/theme.css）都声明了 `@custom-variant dark (&:where(.dark, .dark *))`，
 * `dark:` 工具类与 `.dark` token 块由此同源 —— 只有容器显式带上 .dark 类时才生效。
 * 下方「容器上强制 .dark 作用域」面板依赖这一点，而包内已无任何代码会自动加该类。
 */

const TOKENS: Array<{ name: string; swatch: CSSProperties }> = [
  { name: "--color-brand", swatch: { backgroundColor: "var(--color-brand)" } },
  { name: "--color-primary", swatch: { backgroundColor: "var(--color-primary)" } },
  { name: "--color-secondary", swatch: { backgroundColor: "var(--color-secondary)" } },
  { name: "--color-surface-2", swatch: { backgroundColor: "var(--color-surface-2)" } },
  { name: "--color-status-active", swatch: { backgroundColor: "var(--color-status-active)" } },
  { name: "--color-destructive", swatch: { backgroundColor: "var(--color-destructive)" } },
  { name: "--color-text-primary", swatch: { backgroundColor: "var(--color-text-primary)" } },
  { name: "--color-border", swatch: { backgroundColor: "var(--color-border)" } },
];

/** 两个作用域里重复渲染的同一组样本，用于观察 token 切换的实际效果。 */
function ThemeSamples() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Card title</CardTitle>
        <CardDescription>bg-card · text-card-foreground · border-border</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm">Primary</Button>
          <Button size="sm" variant="secondary">
            Secondary
          </Button>
          <Button size="sm" variant="outline">
            Outline
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
          <StatusBadge status="enabled" />
          <StatusBadge status="disabled" />
        </div>
        <Progress value={64} />
        <Input placeholder="border-input · placeholder token" />
      </CardContent>
    </Card>
  );
}

/**
 * 对比面板。forceDark 时给容器加 .dark 类，容器内的 token 变量随即切换；
 * 容器自身必须显式声明 bg-background / text-foreground —— body 上已计算好的颜色会以继承值进入面板，
 * 只加 .dark 而不重设这两项，面板背景不会跟着作用域变化。
 */
function ThemePreviewPanel({
  title,
  forceDark,
  children,
}: {
  title: string;
  forceDark?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("bg-background text-foreground rounded-lg border border-border p-4", forceDark && "dark")}>
      <p className="text-muted-foreground mb-3 text-xs">{title}</p>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

export function DesignTokensSection() {
  const { t } = useTranslation(DEMO_NS);
  const { theme, resolvedTheme } = useTheme();

  return (
    <section>
      <h1 data-slot="demo-section-title" className="mb-6 text-[24px] font-semibold">
        {t("sections.designTokens")}
      </h1>
      <p className="mt-3 text-text-muted text-[12px]">{t("sectionHints.designTokens")}</p>

      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          强制亮色 / useTheme
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="outline">{`theme: ${theme} · resolved: ${resolvedTheme}`}</Badge>
        </div>
        <p className="mt-3 text-text-muted text-[12px]">
          上下文的两个读数恒为 light：Provider 不读 localStorage、不监听 prefers-color-scheme，包内也不再有 setTheme
          或切换入口，任何来源都无法把界面切回深色。
        </p>
      </div>

      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          显式 .dark 作用域对组件的影响
        </h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <ThemePreviewPanel title={`当前作用域（resolved: ${resolvedTheme}）`}>
            <ThemeSamples />
          </ThemePreviewPanel>
          <ThemePreviewPanel title="容器上强制 .dark 作用域" forceDark>
            <ThemeSamples />
          </ThemePreviewPanel>
        </div>
        <p className="mt-3 text-text-muted text-[12px]">
          面板里的背景、文字、边框与状态色都来自包内 token 变量。右侧面板在容器上显式加了 .dark 类， token 与 `dark:`
          前缀的工具类因此一同切换 —— 深色在当前仓库只剩这一条「显式作用域」路径， 没有任何代码会自动给 documentElement
          加上该类。
        </p>
      </div>

      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          Design tokens
        </h2>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
          {TOKENS.map((token) => (
            <div key={token.name} className="overflow-hidden border border-border rounded-[var(--radius)]">
              <div className="h-12" style={token.swatch} />
              <div className="px-2 py-1.5 text-text-secondary text-[12px]">{token.name}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          全局强制亮色
        </h2>
        {/*
          长段说明按句子拆成字符串片段而不是直接写 JSX 文本：格式化器会重排 JSX 文本，
          中英混排时容易在句中插空格，字符串片段能保持我在源码里写下的断句。
        */}
        <p className="text-muted-foreground text-sm">
          {"亮色是常量而非默认值：ThemeProvider 不读 localStorage、不监听 prefers-color-scheme，"}
          {"也不把 light / dark 类写到 document.documentElement 上；"}
          {"它仍然提供上下文（theme / resolvedTheme 恒为 light），并在挂载时清掉 documentElement 上"}
          {"残留的 dark 类，兜住「上一版本写过」与「扩展脚本塞类」两类外部来源。"}
          {"demo 与宿主都在根部挂载它，整个展示页共享同一份上下文。"}
        </p>
        <p className="text-muted-foreground mt-3 text-sm">
          {"两个主题入口（宿主 apps/web/src/index.css 与包内 web/styles/theme.css）都声明了"}
          {"@custom-variant dark (&:where(.dark, .dark *))，把 Tailwind 默认「跟随 prefers-color-scheme」"}
          {"的 dark: 变体改为类作用域。因此系统深色偏好不再能让任何界面自发变深，"}
          {"而包内数十处 dark:* 变体一个都不用删——它们只在显式 .dark 作用域下生效。"}
          {"color-scheme 由宿主在 :root 上固定为 light，浏览器原生控件同样走亮色。"}
        </p>
      </div>
    </section>
  );
}
