# ADR：装配 profile 派生的前后端模块启用标识

- 日期：2026-10-08
- 状态：已接受

## 背景

服务端资源模块由部署 profile 选择，浏览器贡献静态编译，`hiddenTabs` 仅表达导航偏好。缺少共同的运行期能力快照时，停用资源仍可能留下前端死链。

## 决策

1. 唯一真相源是 registry 已校验的 assembly profile。宿主 `/web/system/modules` 仅投影资源模块 ID 与 `webContributions` 的键（manifest `web.id`），绝不序列化贡献值或环境配置。端点公开只读、无租户数据，不承载授权；服务端仍靠装配不挂载可选路由及原有资源授权保障安全。
2. 生成器保留 web ID 与浏览器贡献载荷的对应关系。运行期有效集合 = 构建期集合 ∩ 服务端 web 清单；**bundle 是上界，运行期只能收窄**。重新开启未打包贡献必须重新构建交付。
3. 根 Provider 只拉取一次并共享快照。根路由出口统一拦截导航派生的 `/agent/<id>` 及子路径，非导航入口由贡献 owner 声明 `routePrefixes`。采用完整路径段、最长前缀匹配，不引入动态路由注入，也不要求各页面实现判断。
4. 加载中不挂载受控业务子树；关闭时渲染明确的「未启用」；失败（含响应校验失败）恢复构建期能力、显示可重试提示并记录一次固定分类的结构化错误，不记录原始响应。fail-open 是可用性取舍，不是服务端授权降级。
5. `hiddenTabs` 与装配裁剪取并集用于导航，偏好本身不限制直达。两者不可互相替代；部署 `FENIX_FEATURE_*` 不自动映射为 profile。

## 边界与后果

- 本机制覆盖带 web contribution 的入口；未声明 web 贡献的管理/协议能力不被推断为可选 UI。新增非导航页面必须声明其路径归属。
- 浏览器使用应用生命周期快照，部署 profile 变更后重新打开/刷新应用；运行期不监听热变更。滚动部署必须保持各副本 profile 一致，否则清单请求与业务请求可能落在不同能力的副本。
- 默认 CE profile 不变。测试 fixture 仅移除 `workflow-v2` 及 web ID `workflow`，不移除旧 `workflow` 资源模块，旧 API 合同不受影响。
- 回滚时撤回宿主清单与前端消费改动即可恢复静态导航，profile 与数据库无需迁移。新前端遇到旧后端端点不存在会 fail-open 并提示，而非关闭全部模块。

## 验证

`system-modules.test.ts` 校验 profile fixture → 装配选择/路由贡献 → 宿主响应；`assembly-capabilities.test.tsx` 校验同一 fixture 的导航叠加、所有贡献入口与工作流子路径；`assembly-provider.test.tsx` 校验单请求共享、错误信号和重试恢复；生成器测试验证资源 ID 与 web ID 不同的情况。
