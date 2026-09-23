/**
 * 观察台「原始 id 弱化小字」配方：等宽 + 10px + muted 字色。
 *
 * 为什么抽成模块：这串类在 observer 的 4 个展示文件里逐字重复了 7 次
 * （`AdminPeoplePage` 的组织/用户/Agent/machine id 4 处，`ObserverOrgTree` / `ObserverMachineTree` /
 * `ObserverFlatTable` 的 name(id) 对照展示各 1 处）。它们表达的是同一个视觉意图——可读名称旁边跟随
 * 原始 id，靠字号更小 + 字色更弱与主标题拉开层级；改字号或改字色时这几处必须同批改完，共享后这个约束
 * 只落在一处。
 *
 * 为什么只收口类串、不抽组件：调用点既有裸 `<span>`，也有带 `title`、外层 `min-w-0` 的组合
 * （`NodeTitle`、`ChatRelayStats` 一类），元素形态各异，抽组件得把差异塞进 props，反而把差异藏起来；
 * 先只把外观配方收成一份（与 workflow `entry-field-classes.ts`、task `chip-classes.ts` 同据）。
 *
 * 落点：4 个消费文件跨 `pages/admin/` 与 `pages/admin/components/`，取公共父目录 `pages/admin/`，
 * 两侧引用分别为 `./observer-meta-classes` 与 `../observer-meta-classes`，不引入新目录。
 *
 * 字号用刻度类 `text-3xs`（宿主 `apps/web/src/index.css` 的 `@theme` 定义了 `--text-3xs: 10px`），
 * 与它替换掉的 10px 任意值字号逐字等价：该刻度刻意不带 `--text-3xs--line-height`，因此只产出
 * `font-size: var(--text-3xs)`（10px），不附带 line-height 声明。
 *
 * 刻意**不**收的邻近写法：`Badge` 上的 10px 任意值字号（11 处）——它只换字号、外层观感由
 * `variant` 决定，且分散在不同语义的徽章上（角色、来源、计数、kind），抽常量会把无关的徽章绑到一起。
 */
export const OBSERVER_META_CLASS = "font-mono text-3xs text-text-muted";
