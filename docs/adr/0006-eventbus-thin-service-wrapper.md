# EventBus Thin Service Wrapper

EventBus 不再全局直接访问。创建 EventService 薄封装（1:1 代理 publish/subscribe/getEventsSince），通过 Elysia `.decorate()` 全局单例注入。调用者改 import 路径，不改业务逻辑。

Status: accepted
