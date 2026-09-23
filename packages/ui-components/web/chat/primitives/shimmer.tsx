import "./shimmer.css";

import { motion, useReducedMotion } from "motion/react";
import { type CSSProperties, type ElementType, type JSX, memo } from "react";

import { cn } from "../../lib/cn";

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
  /**
   * 逐字级联进场 + 持续扫光（cascade shimmer）。
   *
   * 默认关闭，既有调用点（工具行运行中的标题）行为不变：那类文案可能很长，逐字拆成 `span`
   * 会改变断行与文本截断的落点，只有「思考中」这类短标签适合逐字进场。
   *
   * 开启后的两段动效：
   * - 进场：每个字符独立 `span`，带 `index × CASCADE_STAGGER_SECONDS` 的阶梯延迟，
   *   从 `opacity: 0 / y: 100%` 收到 `opacity: 1 / y: 0%`（为什么必须每字符独立，见 `CascadeText`）；
   * - 持续：逐字推进的渐变扫光（伴生 `shimmer.css` 的 `.shimmer-cascade-char`），无限循环。
   *
   * 级联只在该组件挂载时播一次——文案是常量（如「思考中」），没有短语切换来触发重播；
   * 挂载后承担「还在干活」信号的是扫光，不是级联。
   */
  cascade?: boolean;
}

/** 逐字阶梯延迟（秒）：第 n 个字符比第一个晚 `n × 该值` 进场。 */
const CASCADE_STAGGER_SECONDS = 0.025;

/** 扫光的逐字相位差（秒）：第 n 个字符的渐变相位比第一个晚 `n × 该值`，亮带才会横着扫过整句。 */
const CASCADE_SWEEP_STAGGER_SECONDS = 0.05;

/** 进场缓动：位移从 `100%` 收到 `0%`，阻尼取在临界附近，避免整行标签跟着弹跳。 */
const CASCADE_TRANSITION = { type: "spring", stiffness: 320, damping: 30 } as const;

/** 空白字符判定：单独放进 `inline-block` 的空白会被折叠成零宽，需要保留其宽度。 */
const WHITESPACE = /\s/;

/**
 * 逐字级联进场的字符序列。
 *
 * 无障碍：可见字符整体 `aria-hidden`，完整句子由同级 `sr-only` 提供——否则读屏会把
 * 「思考中」逐字读成三个独立节点，外层按钮的可访问名也会被拆散。
 *
 * 渐变与裁切落在**每个字符自己**身上（`shimmer-cascade-char`），不是外层容器。这是 Chrome 的
 * 硬约束，工装实测：祖先 `background-clip: text` 的裁切蒙版**不包含身上带动画的子孙字形**，
 * 叠加 `-webkit-text-fill-color: transparent` 后整段文字在动画期间完全不落栅格——入场那 0.5s
 * 会整句不可见、动画结束后才「跳」出来；裁切与动画同处一个元素时则正常逐帧着色。代价是
 * 扫光按字符推进（相位差 `CASCADE_SWEEP_STAGGER_SECONDS`）而不是一条贯穿全句的亮带。
 */
const CascadeText = ({ text }: { text: string }) => (
  <>
    <span aria-hidden="true">
      {/* 按码点切分（`Array.from`）：`split("")` 会把 emoji 等代理对切成两半。
          键、进场延迟与扫光相位都在这里按位置算好：字符序列来自常量文案，位置即身份；
          键字面量先算好再传给 `key`，与 `agent-skills-catalog` 的骨架行同一处理——
          biome 的 `lint/suspicious/noArrayIndexKey` 不接受直接用下标当键。 */}
      {Array.from(text, (character, index) => ({
        character,
        enterDelay: index * CASCADE_STAGGER_SECONDS,
        key: `${index}-${character}`,
        sweepDelay: `${(index * CASCADE_SWEEP_STAGGER_SECONDS).toFixed(3)}s`,
      })).map(({ character, enterDelay, key, sweepDelay }) => (
        <motion.span
          animate={{ opacity: 1, y: "0%" }}
          className={cn("shimmer-cascade-char inline-block", WHITESPACE.test(character) && "whitespace-pre")}
          initial={{ opacity: 0, y: "100%" }}
          key={key}
          // 自定义属性要落在内联样式上（逐字相位差是位置函数），`MotionStyle` 不接受 `--*` 键。
          style={{ "--shimmer-sweep-delay": sweepDelay } as CSSProperties}
          transition={{ delay: enterDelay, ...CASCADE_TRANSITION }}
        >
          {character}
        </motion.span>
      ))}
    </span>
    <span className="sr-only">{text}</span>
  </>
);

const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  cascade = false,
}: TextShimmerProps) => {
  const MotionComponent = motion.create(Component as keyof JSX.IntrinsicElements);

  // 减弱动效偏好。级联与呼吸都是 JS 动画，`theme.css` / 宿主 `index.css` 里那条全局
  // `@media (prefers-reduced-motion: reduce)` 只压得住 CSS 动画，管不到这里，因此显式读偏好：
  // 开启后两种形态都退化成静态文本（扫光是 CSS 动画，另由 `shimmer.css` 同址降级兜底）。
  const shouldReduceMotion = useReducedMotion();

  if (cascade && !shouldReduceMotion) {
    return (
      <MotionComponent className={cn("relative inline-block text-muted-foreground", className)}>
        <CascadeText text={children} />
      </MotionComponent>
    );
  }

  return (
    <MotionComponent
      animate={shouldReduceMotion ? undefined : { opacity: [0.5, 1, 0.5] }}
      className={cn("relative inline-block text-muted-foreground", className)}
      transition={
        shouldReduceMotion
          ? undefined
          : {
              repeat: Number.POSITIVE_INFINITY,
              duration,
              ease: "easeInOut",
            }
      }
    >
      {children}
    </MotionComponent>
  );
};

export const Shimmer = memo(ShimmerComponent);
