/**
 * 轻量级配置变更事件系统
 * 基于 CustomEvent 实现跨页面/组件的配置变更通知
 */
import { useEffect } from "react";

const CONFIG_CHANGE_EVENT = "rcs:config-change";

export type ConfigModule = "agents" | "models" | "skills" | "mcp" | "providers";

/**
 * 派发配置变更事件
 * 在配置页面保存/删除/切换操作成功后调用
 */
export function dispatchConfigChange(module: ConfigModule) {
  window.dispatchEvent(new CustomEvent(CONFIG_CHANGE_EVENT, { detail: { module, timestamp: Date.now() } }));
}

/**
 * React hook：监听配置变更事件，触发回调
 */
export function useConfigChangeListener(callback: (module: ConfigModule) => void, deps: Array<unknown>) {
  useEffect(() => {
    const handler = (e: Event) => {
      const { module } = (e as CustomEvent<{ module: ConfigModule }>).detail;
      callback(module);
    };
    window.addEventListener(CONFIG_CHANGE_EVENT, handler);
    return () => window.removeEventListener(CONFIG_CHANGE_EVENT, handler);
    // biome-ignore lint/correctness/useExhaustiveDependencies: deps is a caller-provided array, intentionally dynamic
  }, deps);
}
