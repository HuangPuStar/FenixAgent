import type { ModuleManifest } from "@fenix/platform-sdk";

/**
 * Channel 资源模块描述符。
 *
 * 本模块当前只持有 IM 通道的持久化定义（`im_channel` / `im_channel_route`，出口
 * `@fenix/resource-channel/db`）：Hermes 网关、通道绑定路由与控制台页面已随 Hermes 移除一并删除，
 * 消息通道能力与 LangBot 接入随后续任务重建——届时再在这里声明 `envDefinitions`、路由贡献与 `create`。
 *
 * `dependsOn: []`：本包是叶子模块，装配上不要求任何其它资源模块同批启用。跨包外键的列对象只在
 * `db/schema.ts` 的组装期导入（§6.1 例外），不构成装配边。
 */
export const moduleManifest = {
  id: "channel",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.channel"],
} satisfies ModuleManifest;
