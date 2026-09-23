import { cn } from "../lib/cn";
import { StatusDot, type StatusDotTone } from "./status-dot";
import "./connection-status.css";

/**
 * 包内同构联合类型，替代原先从业务层聊天包引入的连接状态类型。
 *
 * 已知限制：业务层传输包的连接状态联合类型与本定义是两份独立声明，任一侧新增状态时需同步。
 * 影响范围：仅本模块的 StatusIndicator / ConnectionStatusBar 及其调用方。
 * 移除条件：当连接状态类型下沉为可被本包直接依赖的共享类型定义后，删除本定义改为引用该共享类型。
 */
export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/**
 * 连接态 → 色调。**本文件不再自带圆点渲染**：圆点唯一实现在 `./status-dot`，本模块只负责
 * 「连接态」这一层语义翻译（色调映射 + 连接态特有的光晕），是那个通用原语的一个普通调用方。
 *
 * 曾经的 `StatusDot`（入参 `ConnectionState`、颜色写死在 `connectionDotStyles`）已删除：
 * 它把「圆点怎么画」和「连接态是什么色」混在一起，非连接语义的调用方（宿主实例树、知识库目录）
 * 无法复用，只能各自再写一份圆点。色调是两者唯一能共享的层次，故按色调下沉、连接态留在本文件。
 */
const CONNECTION_TONES: Record<ConnectionState, StatusDotTone> = {
  disconnected: "neutral",
  connecting: "warning",
  connected: "success",
  error: "danger",
};

/**
 * 连接态特有的装饰：已连/出错时给圆点加光晕（色值落在 `connection-status.css`）。
 * 通用圆点不带装饰，故由本模块按状态附加。
 */
const CONNECTION_DOT_GLOW: Partial<Record<ConnectionState, string>> = {
  connected: "connection-dot-glow-connected",
  error: "connection-dot-glow-error",
};

/** 连接态圆点：色调 + 过渡态呼吸 + 光晕三个决定都在本模块，圆点本体来自 `./status-dot`。 */
function ConnectionDot({ state, className }: { state: ConnectionState; className?: string }) {
  return (
    <StatusDot
      tone={CONNECTION_TONES[state]}
      pulse={state === "connecting"}
      className={cn(CONNECTION_DOT_GLOW[state], className)}
    />
  );
}

// Shared labels for connection states
// 标签为英文默认值；宿主需要其它语言时可按 state 自行映射标签并直接渲染，不必依赖本文案。
const connectionStateLabels: Record<ConnectionState, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting...",
  connected: "Connected",
  error: "Error",
};

/**
 * Get the display label for a connection state
 */
export function getConnectionStateLabel(state: ConnectionState): string {
  return connectionStateLabels[state];
}

/**
 * A status indicator with dot and label
 * Used in cards and detailed views
 */
export function StatusIndicator({ state, className }: { state: ConnectionState; className?: string }) {
  return (
    <span className={cn("flex items-center gap-2 text-sm font-normal", className)}>
      <ConnectionDot state={state} />
      {state}
    </span>
  );
}

/**
 * A complete status bar section with dot, label, and optional URL
 */
export function ConnectionStatusBar({
  state,
  displayUrl,
  className,
}: {
  state: ConnectionState;
  displayUrl?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <ConnectionDot state={state} />
      <span className="text-sm font-medium">{getConnectionStateLabel(state)}</span>
      {state === "connected" && displayUrl && (
        <span className="text-xs text-muted-foreground truncate max-w-37.5">{displayUrl}</span>
      )}
    </div>
  );
}
