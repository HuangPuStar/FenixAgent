/**
 * Channel 资源包根入口（`@fenix/resource-channel`）。
 *
 * 刻意为空：本包当前只有两个对外面——表定义出口 `@fenix/resource-channel/db`
 * （`im_channel` / `im_channel_route`）与模块描述符 `@fenix/resource-channel/module`。
 * 通道的服务端路由与浏览器页面随 Hermes 移除一并删除，随后续的 LangBot 接入任务重建；
 * 在那之前不要从这里转出任何实现，否则消费方会绕过面边界。
 */

export {};
