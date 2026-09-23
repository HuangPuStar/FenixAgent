# 严格禁止的代码行为（扫描门禁清单）

> **用途**：把「明显不该出现、但 review 容易漏」的写法固化成**可被脚本机械识别**的规则，作为 code review 之外的第二道防线。
>
> **状态**：Web 样式域（`FCP-WEB-01..03`）已实现并接入 `precheck`；用户口述条目 4 待补。
>
> **级别**：`P1` = 严格禁止，命中数必须为 0（存量按目录登记在台账里，只允许下降）。
>
> **反例取材**：全部来自本仓库真实代码，且被 `scripts/__tests__/web-style-rules.test.ts` 逐条锁住——
> 文档里的反例改了而检测没改（或反之）会在测试里失败。
>
> **实现**：`scripts/lib/web-style-rules.ts`（规则与判定）、`scripts/lib/web-style-debt.ts`（存量台账）、
> `scripts/check-web-style.ts`（门禁入口）。

## 规则表

| ID | 级别 | 禁止行为 | 检测信号 |
|----|------|----------|----------|
| `FCP-WEB-01` | P1 | 用任意值工具类（`-[...]`）写本可标准化的尺寸/颜色 | 值为 `数字+px/rem/em` 或颜色字面量（`#hex`、`rgb()`、`hsl()` 等） |
| `FCP-WEB-02` | P1 | 深层样式（选择器嵌套、复合表达式）堆成 className | 变体含 `&`（`[&>span]:`、`[&:hover]:`）；或值含空格转义 `_` / 函数调用（`shadow-[0_4px_14px_rgb(...)]`） |
| `FCP-WEB-03` | P1 | 手写任意 `@media` / `@supports` 变体做响应式 | 任意 at-rule 变体（`[@media...]:`）；任意断点变体（`min-[760px]:`） |

**优先级**：一个 token 只报一条，取最外层写法 —— 变体（03 → 02）先于值（01）。
`[&>svg]:w-[11px]` 要改的是结构表达式，单独把 `11px` 换成刻度没有意义。
`[@media(...)]:[&>span]:size-6` 同时命中 03 与 02，报 03。

---

## FCP-WEB-01 · 任意值工具类（arbitrary values）

**禁止**：能用设计刻度 / token 表达的尺寸、字号、间距、颜色，却写成 `-[...]` 任意值。

**反例**

```tsx
<span className="text-[12px] px-[9px] py-[10px] gap-[10px] rounded-[11px] border-[#e0e7f0]" />
```

**正例**

```tsx
{/* 标准刻度优先 */}
<span className="text-xs px-2 py-2.5 gap-2.5 rounded-lg border-border" />

{/* 刻度缺失时：先在 @theme 补 token，再用语义类，而不是就地写死像素 */}
```

**为什么是 P1**：任意值绕过整套设计 token —— 主题切换、密度调整、后续统一改版全部失效，且同一视觉意图会在仓库里扩散成几十种近似写法（首次接入时 `FCP-WEB-01` 存量 1668 处，现已清零；见文末「存量清理结果」）。

**豁免**：`var(...)` 引用（`bg-[var(--surface-1)]`、`w-[calc(var(--rail)*2)]`）是 token 体系的合法延伸，不报。

---

## FCP-WEB-02 · 深层样式必须落 CSS，不得堆 className

**禁止**：需要子代选择器、伪态、结构匹配、阴影等复合表达式才能表达的「深层样式」，用一长串 Tailwind 表达式硬拼在组件里。

**反例**（真实原文，一条样式常量拼接了布局 + 颜色 + 阴影 + 过渡 + 5 组子代选择器 + 4 段响应式；检测命中 30 处）

```tsx
const SUMMARY_CARD =
  "grid w-full min-h-[72px] grid-cols-[32px_minmax(0,1fr)_12px] items-center gap-[10px] rounded-[11px] border " +
  "border-[#e0e7f0] bg-[rgb(255_255_255_/_94%)] px-[9px] py-[10px] text-left text-[#53637b] " +
  "shadow-[0_4px_14px_rgb(35_60_105_/_5%)] " +
  "transition-[border-color_140ms_ease,transform_140ms_ease,box-shadow_140ms_ease] " +
  "[&:hover]:-translate-x-[2px] [&:hover]:border-[#aac3ef] [&:hover]:shadow-[0_8px_20px_rgb(35_60_105_/_9%)] " +
  "[&>span]:grid [&>span]:size-8 [&>span]:place-items-center [&>span]:rounded-[9px] [&>span]:bg-[#eaf2ff] [&>span]:text-[#2f69d2] " +
  "[&>div]:flex [&>div]:min-w-0 [&>div]:flex-col [&>svg]:w-[11px] [&>svg]:text-[#a2adbd] " +
  "[@media(min-width:760px)and(max-width:1119px)]:min-h-[48px] [@media(min-width:760px)and(max-width:1119px)]:grid-cols-[24px_minmax(0,1fr)_10px] " +
  "[@media(min-width:760px)and(max-width:1119px)]:px-[7px] [@media(min-width:760px)and(max-width:1119px)]:py-[6px] " +
  "[@media(min-width:760px)and(max-width:1119px)]:[&>span]:size-6";
```

**正例**

```tsx
{/* 结构：拆成组件 + 语义类名；深层样式：落到同目录 CSS */}
<button className="summary-card">
  <span className="summary-card__icon">{icon}</span>
  <div className="summary-card__body">{children}</div>
  <ChevronRight aria-hidden />
</button>
```

```css
/* summary-card.css —— 与组件同名同目录 */
.summary-card { /* 布局、颜色走 token */ }
.summary-card:hover { /* 伪态、阴影、过渡 */ }
.summary-card > span { /* 子代结构 */ }
@media (min-width: 760px) and (max-width: 1119px) { /* 区间响应式 */ }
```

**为什么是 P1**：这类表达式把「结构」和「表现」焊死在字符串里 —— `[&>span]` 一旦 DOM 多包一层就静默失效；重构、调试、响应式调整成本极高；同一张卡片在几处出现就会漂移成几种近似样式。**凡是需要选择器层级才能表达的样式，就是 CSS 的职责，不是工具类的职责。**

**判据（避免误伤）**：单层工具类（`flex items-center gap-2 rounded-lg`）合法；出现**选择器嵌套**（`[&>*]`、`[&:hover]`、`[&_svg]`）或**复合表达式值**（`_` 空格转义、函数调用）时，即应下沉为 CSS。

**已知取舍**：`w-[min(...)]`、`bg-[linear-gradient(...)]` 这类「无法用单一刻度表达、但确实只有一处」的写法也会报 02。这是刻意的：它们同样属于「用字符串写样式」，落到有名字的 CSS 类里可读性更好。真遇到必须保留的场景，走台账登记而不是放宽规则。

---

## FCP-WEB-03 · 响应式必须用 Tailwind 规范断点

**禁止**：手写任意媒体查询变体做响应式布局。

**反例**

```tsx
<div className="[@media(min-width:760px)and(max-width:1119px)]:hidden" />
```

**正例**

```tsx
{/* 标准断点（Tailwind v4 默认：sm 640 / md 768 / lg 1024 / xl 1280 / 2xl 1536） */}
<div className="md:max-lg:hidden" />

{/* 设计稿区间不在标准断点上：先在 @theme 声明命名断点，再用命名断点 */}
{/* @theme { --breakpoint-tablet: 760px; --breakpoint-tablet-max: 1119px; } */}
<div className="tablet:max-tablet-max:hidden" />
```

**为什么是 P1**：内联 media query 绕过断点体系，导致：

1. 一套设计稿的区间被逐处手抄，改一处设计要 grep 全仓；
2. 与项目断点互不知情，同页面出现两套互相打架的响应式轴；
3. Tailwind 无法对其排序/去重，冲突时结果依赖生成顺序。

**注意**：`min-[760px]:` 这类**任意变体**同样属于本规则打击对象 —— 它只是把 `@media` 换了个写法，没有接入断点体系。

---

## 4. （待补：用户口述条目 4）

---

## 扫描门禁的用法

```bash
bun run check:web-style                            # 门禁：只阻断新增/上升
bun run check:web-style --write-baseline           # 同步台账：清理后重跑，只允许调低或删条目
bun run check:web-style --write-baseline --force   # 首次建基线；抬高基线须 review 说明
```

已接入 `precheck`（`scripts/ci.ts` 的 `web-style` 步骤）。

**扫描范围**：`apps/web/src/**`、`packages/**/web/**` 下的 `.ts` / `.tsx`（即 Tailwind `@source` 覆盖的源码）。
排除 `__tests__`、`*.test.*`、`*.spec.*`、`dist`、`node_modules` —— 测试里的类名字符串是断言夹具，不产生渲染成本，纳入扫描只会淹没真实命中。

**扫描单位是字符串字面量（AST），不是整文件正则**：反例经常被写进注释解释「不要这样写」，正则会把注释本身报成违规。

**存量台账**（`scripts/web-style/exceptions.json`）：按「规则 + 目录」登记命中数，棘轮只降不升。

- 台账里没有的组合出现命中 → 失败（新增）；
- 已登记组合命中数上升 → 失败（新增）；
- 命中数下降 → 只提示同步台账，不失败。

首次接入的口径：`FCP-WEB-01` 1668 处、`FCP-WEB-02` 797 处、`FCP-WEB-03` 140 处，合计 2605 处，分布在 42 个目录、75 条（规则 × 目录）记录，`owner` 统一记「未排期」。

**台账当前为空**（`"exceptions": []`）：2026-09 的一次全量整改把 2605 处存量全部清掉，门禁回到「任何命中即失败」的严格状态。台账文件与 `--force` 语义保留，供将来出现「确需分期偿还」的存量时使用 —— 但登记前必须先问「为什么不是现在就改掉」。

**为什么要 `--force` 才能抬高基线**：生成器若默认接受当前状态，一条命令就能把新增违规洗成存量；安全方向（下降）零摩擦，危险方向（上升）留痕。

**改规则的正确顺序**：先改 `docs/developer/guide/forbidden-code-patterns.md`（口径）→ 再改 `scripts/lib/web-style-rules.ts`（判定）→ 再改 `scripts/__tests__/web-style-rules.test.ts`（反例锚点）→ 最后重跑 `--write-baseline` 同步计数。跳过测试那一步等于偷偷放宽门禁。

---

## 存量清理结果（2026-09）

2605 处存量按三条规则分别处理，**两条机械、一条需要判断**：

| 规则 | 处理方式 | 结果 |
|------|----------|------|
| `FCP-WEB-01` 任意长度/颜色 | 就近映射到标准刻度：px ÷ 4 取间距档、最近色阶、最近字号档、最近圆角/行高/字距/模糊档 | 1499 → 0 |
| `FCP-WEB-03` 任意媒体查询/断点 | 就近落到标准断点（`max-[950px]:` → `max-lg:`、`[@media(max-width:759px)]:` → `max-md:`） | 139 → 0 |
| `FCP-WEB-02` 深层样式 | **下沉为同目录、与源文件同名的 CSS 类**（见下） | 795 → 0；重分类后总数 817 → 0 |

### 02 的下沉约定

`02` 的判断依赖语境，机械替换做不到，因此约定了一套固定修法（整改时按目录分片并行执行）：

- **CSS 落位**：与源文件同目录、同名的 `.css`（`AgentEditorChrome.tsx` → `AgentEditorChrome.css`），由持有该样式的模块顶部 `import` 引入。这是 §10「确实必须写 CSS 时优先放组件同目录、命名与组件同名」的落地形态。
- **类名**：优先沿用源码里记录的**源选择器名**（这批文件多是「原 CSS 改写成 Tailwind 字符串」的产物），否则用 `kebab-case` 语义名。
- **选择器**：写普通 CSS 选择器（`.foo > span`、`.foo:hover`、`.dark .foo`），不用 `&` 嵌套；媒体查询就地写 `@media`。
- **不包 `@layer`**：源样式表本就没有分层，未分层才能在层叠中压过 `@layer utilities`。**但下沉时必须逐处确认胜负关系没变** —— 未分层声明一定压过工具类，若原写法是被消费方 `className` 覆盖的，就不能直接下沉（已有实例改为只下沉「值」并由工具类引用 CSS 变量，见 `packages/ui-components/web/ui/alert-dialog.css` 的文件头）。
- **留在 className 的**：扁平、语义清晰的工具类（`flex items-center gap-2 rounded-lg`）。

### 连带影响

整改顺带推翻了上一轮迁移留下的两条口径，相关守卫测试已同批改写（改的是**期望值**，不是守卫意图）：

- `agent-editor` 面板原先「字号一律显式 px 写死、禁止 Tailwind 刻度类」，现改为「字号就近取标准档，只允许白名单刻度」。
- chat 三片样式原先「语义类名一律不得回流 `className`」，现允许「仍被某份样式表定义的类名」作为下沉载体（判据从「类名清单」改为「今天还有没有定义」）。

前者接受 ~1px 的字号偏差（如 `text-[13px]` → `text-xs`），是这次整改**唯一**允许的视觉变化；其余全部为等价换算。


**与前端规范的关系**：本清单是 `docs/developer/guide/frontend-development.md` §10「样式」的**可执行子集**；该节讲「优先用什么」，这里讲「什么绝对不行 + 由谁拦」。
