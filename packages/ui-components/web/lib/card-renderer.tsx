import { type ComponentType, createContext, useContext } from "react";

export interface TagRendererConfig {
  /** 卡片组件，接收标签属性（均为 string 类型）作为 props */
  component: ComponentType<Record<string, unknown>>;
  /** 可选：加载中占位组件 */
  fallback?: ComponentType<Record<string, unknown>>;
  /** rehype-sanitize 需要放行的 HTML 属性名列表，默认 ["*"] */
  allowedAttrs?: string[];
}

/**
 * 自定义标签渲染器注册表 + 卡片事件通道。
 *
 * 安全默认：注册表初始为空，未注册的标签不会被放行渲染 —— `allowedTags` 因此为空集，
 * markdown 中的自定义标签会被 rehype-sanitize 直接剥离。宿主必须显式调用
 * `registerTagRenderer` 才会打开白名单，避免任意标签借 markdown 内容注入。
 *
 * 事件通道（`CardEventEmitter` / `MessageEmitterContext` / `useCardEmit`）原先被判定为
 * 「宿主会话层」而排除在本包外，2026-09-18 依据实际引用关系改判：它们是卡片渲染协议的组成部分
 * （注册的卡片组件靠 `useCardEmit` 把交互抛给宿主），且两个消费方
 * （`agent-runtime` 的 MessageBubble、`agent-config` 的 AgentSitesCard）无法在不依赖
 * 宿主私有模块的前提下取到它们，故并入本文件。实现与源实现
 * （apps/web/src/lib/card-renderer/{emitter,context}）保持行为一致。
 */

const registry = new Map<string, TagRendererConfig>();

/**
 * 注册自定义标签渲染器。
 * 标签名使用 kebab-case（如 "my-card"），无需尖括号。
 * 注册后 streamdown 的 allowedTags 自动包含此标签，components 自动注入。
 *
 * 用法：
 * ```ts
 * registerTagRenderer("my-card", { component: MyCard });
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
  for (const [tag, config] of registry) {
    tags[tag] = config.allowedAttrs ?? ["*"];
  }
  return tags;
}

type Handler<T = unknown> = (payload: T) => void;

/**
 * 轻量级事件发射器，用于卡片组件与外部代码通信。
 * 每条助手消息创建独立实例，实现消息级隔离。
 */
export class CardEventEmitter {
  private handlers = new Map<string, Set<Handler>>();

  /** 订阅事件，返回取消订阅函数 */
  on(event: string, handler: Handler): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set<Handler>();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => this.off(event, handler);
  }

  /** 取消订阅 */
  off(event: string, handler: Handler): void {
    this.handlers.get(event)?.delete(handler);
  }

  /** 发送事件 */
  emit(event: string, payload?: unknown): void {
    const handlers = this.handlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      handler(payload);
    }
  }

  /** 清理所有订阅 */
  destroy(): void {
    this.handlers.clear();
  }
}

/**
 * 消息粒度的 emitter 上下文。
 * 由宿主在渲染助手消息时注入，同一消息内的所有卡片组件共享同一 emitter 实例。
 */
export const MessageEmitterContext = createContext<CardEventEmitter | null>(null);

/**
 * 卡片组件使用此 hook 发送事件。
 * 若不在 `MessageEmitterContext` 内（例如组件被独立使用），返回 noop 函数，不抛错。
 */
export function useCardEmit() {
  const emitter = useContext(MessageEmitterContext);
  if (!emitter) {
    return (_event: string, _payload?: unknown) => {
      // noop — 组件在 Provider 外部被使用，安全降级
    };
  }
  return (event: string, payload?: unknown) => {
    emitter.emit(event, payload);
  };
}
