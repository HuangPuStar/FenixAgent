/**
 * Channel 资源包根入口（`@fenix/resource-channel`）。
 *
 * 当前刻意为空：包对外的三个面已分别有明确入口——浏览器面 `@fenix/resource-channel/web`
 * （含页面、API client、语言资源，由浏览器安全守卫守护）、服务端面
 * `@fenix/resource-channel/server`、模块描述符 `@fenix/resource-channel/module`。
 * 根入口若顺手 re-export 其中任一面，会把服务端实现拖进浏览器解析图，或让消费方绕过面边界；
 * 等 §1.6 的 WebShell 与 §1.5 的宿主装配定型后，再按真实消费需求决定根入口是否需要内容。
 */

export {};
