import type { ComponentType } from "react";

export interface TagRendererConfig {
  /** 卡片组件，接收标签属性（均为 string 类型）作为 props */
  component: ComponentType<Record<string, unknown>>;
  /** 可选：加载中占位组件 */
  fallback?: ComponentType<Record<string, unknown>>;
}

const registry = new Map<string, TagRendererConfig>();

/**
 * 注册自定义标签渲染器。
 * 标签名使用 kebab-case（如 "agent-sites"），无需尖括号。
 * 注册后 streamdown 的 allowedTags 自动包含此标签，components 自动注入。
 *
 * 用法：
 * ```ts
 * registerTagRenderer("agent-sites", { component: SitesCard });
 * ```
 */
export function registerTagRenderer(tagName: string, config: TagRendererConfig): void {
  if (registry.has(tagName)) {
    console.warn(`[card-renderer] Tag "${tagName}" is being overwritten`);
  }
  registry.set(tagName, config);
}

/** 获取单个标签的渲染器配置 */
export function getTagRenderer(tagName: string): TagRendererConfig | undefined {
  return registry.get(tagName);
}

/** 获取所有已注册的标签名 */
export function getRegisteredTags(): string[] {
  return Array.from(registry.keys());
}

/**
 * 生成 streamdown `components` prop 的组件映射。
 * 从注册表中提取所有标签→组件的映射。
 */
export function getRegisteredComponents(): Record<string, ComponentType<Record<string, unknown>>> {
  const components: Record<string, ComponentType<Record<string, unknown>>> = {};
  for (const [tag, config] of registry) {
    components[tag] = config.component;
  }
  return components;
}

/**
 * 生成 streamdown `allowedTags` prop 的白名单。
 * 每个标签允许所有属性（传递 "*"），由 rehype-sanitize 放行。
 */
export function getRegisteredAllowedTags(): Record<string, string[]> {
  const tags: Record<string, string[]> = {};
  for (const [tag] of registry) {
    tags[tag] = ["*"];
  }
  return tags;
}
