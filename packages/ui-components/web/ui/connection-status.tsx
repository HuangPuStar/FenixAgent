import { cn } from "../lib/cn";

/**
 * 包内同构联合类型，替代原先从业务层聊天包引入的连接状态类型。
 *
 * 已知限制：业务层传输包的连接状态联合类型与本定义是两份独立声明，任一侧新增状态时需同步。
 * 影响范围：仅本模块的 StatusDot / StatusIndicator / ConnectionStatusBar 及其调用方。
 * 移除条件：当连接状态类型下沉为可被本包直接依赖的共享类型定义后，删除本定义改为引用该共享类型。
 */
export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

// Shared styles for connection state dots
const connectionDotStyles: Record<ConnectionState, string> = {
  disconnected: "bg-gray-400",
  connecting: "bg-yellow-400 animate-pulse",
  connected: "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]",
  error: "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]",
};

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
 * A small dot indicator for connection state
 * Used in status bars and headers
 */
export function StatusDot({ state, className }: { state: ConnectionState; className?: string }) {
  return <span className={cn("w-2 h-2 rounded-full", connectionDotStyles[state], className)} />;
}

/**
 * A status indicator with dot and label
 * Used in cards and detailed views
 */
export function StatusIndicator({ state, className }: { state: ConnectionState; className?: string }) {
  return (
    <span className={cn("flex items-center gap-2 text-sm font-normal", className)}>
      <StatusDot state={state} />
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
      <StatusDot state={state} />
      <span className="text-sm font-medium">{getConnectionStateLabel(state)}</span>
      {state === "connected" && displayUrl && (
        <span className="text-xs text-muted-foreground truncate max-w-[150px]">{displayUrl}</span>
      )}
    </div>
  );
}
