# @fenix/resource-channel

IM 通道能力的 owner。当前只持有 IM 通道的持久化定义；Hermes 网关、通道绑定协议面与控制台页面已随
Hermes 通道实现一并删除，消息通道能力与 LangBot 接入随后续任务重建。

## 当前交付物

- **表定义出口** `@fenix/resource-channel/db`（`db/schema.ts`）：`im_channel`（IMChannel 一等资源表）与
  `im_channel_route`（IMChannel 路由规则），DDL 与迁移链一致（`bun run check:schema-ddl-drift`）。
  旧的 `channel_binding` 表已由 drop 迁移移除。
- **模块描述符** `@fenix/resource-channel/module`（`fenix.module.ts`）：`id: "channel"` / `kind: "resource"` /
  `dependsOn: []` / `capabilities: ["resource.channel"]`。当前没有 `create`、`envDefinitions`、路由贡献与
  浏览器出口——重建通道能力时按需要在这里新增，并同步 `drizzle.config.ts`、装配 profile 与宿主接线。
- **根入口** `@fenix/resource-channel` 刻意为空，避免消费方绕过面边界。

## 约束

- 两张表目前**没有读写方**：目标态尚未实现，本包不提供仓储，也不得为未确认需求新增字段或表。
- 两条跨包外键（`im_channel.user_id → user.id`、`im_channel_route.environment_id → environment.id`）使
  `db/schema.ts` 在**组装期**导入 `@fenix/identity/db` 与 `@fenix/agent-runtime/db` 的列对象（§6.1 例外，
  不进 `dependsOn`）；`src/**` 对这两个包没有运行期导入。
- 浏览器面（页面、API client、i18n）与服务端路由当前不存在：需要时由后续任务整体新建，不要在宿主复制一份。
