# CE/EE PHY-02 Web 公共壳物理迁移设计

## 目标

将控制台公共壳从根 `web/` 物理迁移至 `apps/web/`，只替换构建和导入路径，保持 `/ctrl` 路由、请求行为、全局样式与静态资源行为不变。

## 范围与归属

`apps/web` 接收入口依赖的公共能力：路由薄适配与生成路由树、全局 CSS、i18n 初始化、`api/request.ts` 及其通用辅助、通用 UI、公共浏览器工具、公共测试工具与 `public/` 静态资源。

`web/` 内的领域页面、业务 API client、业务 i18n、Agent/Chat/Workflow 等业务组件以及它们的专项测试不在本闭包移动；它们由 PHY-03 至 PHY-09 按真实 owner 承接。

## 接线设计

`apps/web/vite.config.ts` 的 `publicDir`、TanStack Router 扫描目录和生成树目录改为 `apps/web` 内的新唯一实现。`@/components` 解析到新的通用 UI；保留通用 `@/src` 到尚未迁移的业务源码，并用精确 alias 将已移动的 `@/src/api/request`、`@/src/i18n` 等公共入口解析到 `apps/web`。这使后续 PHY-03 至 PHY-09 的业务导入继续使用唯一实现，而不建立 shim。

全局 i18n 初始化迁入后，继续直接加载尚未迁移的业务 locale JSON；locale 文件不复制也不改写，待各业务闭包按 owner 迁移。

入口保持现有初始化顺序：浏览器兼容补丁、品牌加载与应用、i18n、卡片注册、路由树、全局 CSS，随后创建带 `/ctrl` basepath 的 router。Vite 代理与原始 URL 保留逻辑不变。

## 删除条件与验证

每项源文件仅在所有调用、路由生成和测试入口都已指向新路径后删除。迁移前后运行公共壳、request、i18n、通用 UI 的专项测试；完成后运行 `bun run typecheck:web`、`bun run build:web` 和旧公共路径引用扫描。不得创建 re-export、shim 或复制实现。

## 非目标

不改变路由 URL、请求解包、UI 文案/样式、业务逻辑或浏览器/服务端依赖边界；不迁移任何领域闭包，不增减依赖。
