# Config Module Schema Per Route

Config-pg 的 6 个模块（providers/models/agents/skills/mcp/user_config）共享公共工具函数（`src/services/config-utils.ts`：JSONB 序列化、错误包装、字段过滤），但每个模块保留独立的 CRUD 逻辑。每个 config 路由文件注册自己的 body schema（Zod），不使用统一的 `ConfigBodySchema`。字段白名单（如 `AGENT_SETTABLE_FIELDS`）从路由的 Zod schema key 列表自动推断，消除重复维护。

Status: accepted
