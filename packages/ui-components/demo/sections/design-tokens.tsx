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
  type Theme,
  ThemeToggle,
  useTheme,
} from "@fenix/ui-components";
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../i18n";

/**
 * Design Tokens 分区：ThemeToggle / useTheme 与包内设计 token 抽样。
 *
 * 本分区是层级导航的第一层：token 是其余所有分区的视觉基底，因此排在 Base UI 之前，
 * 用示例展示「一处 token 改动如何同时作用到按钮、徽标、进度与输入框」。
 *
 * useTheme 必须在包的 ThemeProvider 内调用；demo 在根部（demo/providers.tsx）挂载了
 * ThemeProvider（defaultTheme="system"），本节所有组件共享同一份上下文，Provider 之外调用会直接抛错。
 *
 * 与源实现的差异：apps/web/src/lib/theme.ts 曾把初始主题硬编码为 "light"（defaultTheme 声明但未使用，
 * 即「暂时强制浅色」的临时 hack），因此主题选择不跨刷新保留、defaultTheme 也不生效。包内改为
 * 「localStorage 记录 ?? defaultTheme」，theme 为 system 时跟随 matchMedia，ThemeToggle 才真正可用。
 *
 * 已知限制：包内只有 token 变量与 .dark 变量块，没有声明 `@custom-variant dark`，因此 `dark:` 工具类变体
 * 仍由 Tailwind 默认的 prefers-color-scheme 决定，不跟随 ThemeProvider 的类切换（StatusBadge 的 dark: 类属于这一类）。
 * 影响范围：仅 `dark:` 前缀的工具类；依赖 token 工具类（bg-background / text-foreground 等）的组件正常跟随。
 * 移除条件：宿主需要「类切换与 dark: 变体一致」时，在主题样式入口补
 * `@custom-variant dark (&:where(.dark, .dark *))`，本段说明随之删除。
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

const THEME_OPTIONS: Theme[] = ["light", "dark", "system"];

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
  const { theme, resolvedTheme, setTheme } = useTheme();

  return (
    <section>
      <h1 data-slot="demo-section-title" className="mb-6 text-[24px] font-semibold">
        {t("sections.designTokens")}
      </h1>
      <p className="mt-3 text-text-muted text-[12px]">{t("sectionHints.designTokens")}</p>

      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          ThemeToggle / useTheme
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <ThemeToggle />
          <Badge variant="outline">{`theme: ${theme} · resolved: ${resolvedTheme}`}</Badge>
          {THEME_OPTIONS.map((option) => (
            <Button
              key={option}
              size="sm"
              variant={theme === option ? "default" : "ghost"}
              onClick={() => setTheme(option)}
            >
              {option}
            </Button>
          ))}
        </div>
        <p className="mt-3 text-text-muted text-[12px]">
          ThemeToggle 内部调用的是同一个 useTheme().setTheme，两者读写同一份上下文，因此这里的读数会同步变化。
        </p>
      </div>

      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          light / dark 对组件的影响
        </h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <ThemePreviewPanel title={`跟随当前主题（resolved: ${resolvedTheme}）`}>
            <ThemeSamples />
          </ThemePreviewPanel>
          <ThemePreviewPanel title="容器上强制 .dark 作用域" forceDark>
            <ThemeSamples />
          </ThemePreviewPanel>
        </div>
        <p className="mt-3 text-text-muted text-[12px]">
          切换主题只是改写 document.documentElement 上的 light / dark 类，面板里的背景、文字、边框与状态色都来自包内
          token 变量；强制作用域同样只作用于 token，`dark:` 前缀的工具类跟随 prefers-color-scheme，不受作用域或
          ThemeToggle 影响。
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
          ThemeProvider：与源应用的差异
        </h2>
        {/*
          长段说明按句子拆成字符串片段而不是直接写 JSX 文本：格式化器会重排 JSX 文本，
          中英混排时容易在句中插空格，字符串片段能保持我在源码里写下的断句。
        */}
        <p className="text-muted-foreground text-sm">
          {"包的 ThemeProvider 只维护 theme / resolvedTheme / setTheme，"}
          {"并把 light / dark 类写到 document.documentElement 上供包内 token 生效。"}
          {"初始主题取 localStorage 记录，没有记录时才回退 defaultTheme；"}
          {"theme 为 system 时跟随 matchMedia 系统偏好，切换会写回 localStorage。"}
          {'demo 在根部挂载它（defaultTheme="system"），整个展示页共享同一份主题状态。'}
        </p>
        <p className="text-muted-foreground mt-3 text-sm">
          {"源应用 apps/web/src/lib/theme.ts 把初始主题硬编码为 light（defaultTheme 未使用），"}
          {"即「暂时强制浅色」的临时 hack：刷新后必然回到浅色，用户的选择不会恢复。"}
          {"包内实现移除了该 hack，初始值改为「localStorage 记录 ?? defaultTheme」，"}
          {"ThemeToggle 的选择因此会被记住，本节也才能真的看到 light / dark 切换。"}
        </p>
      </div>
    </section>
  );
}
