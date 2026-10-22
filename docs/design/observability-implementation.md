# 标准观测实施记录

## 1. 依据与基线

- 设计来源：`/Users/konghayao/Desktop/fenixagent-observability-detailed-design.md`，v1.0，1117行，完整分段阅读。
- 文档源码基线：`bcdd237612b9afa8da1c1b016beb266f2b3c1297`。
- 实施基线：`bea636ca87c960eb048caa2786142040a558aabc`，分支 `feat/observability`。
- worktree：`/Users/konghayao/code/pazhou/remote-control-server-observability`。主仓库不改代码，不提交、不推送。
- `git diff bcdd237… HEAD --stat -- <§2相关路径>` 为空；文档 §2 相关代码未漂移。

## 2. 冻结组合

| 组件 | 版本 |
| --- | --- |
| Bun | 1.4.2 |
| Elysia | 1.4.28 |
| 官方插件 | `@elysia/opentelemetry` 1.4.12（不是旧 `@elysiajs/opentelemetry`） |
| OTel API | 1.9.0 |
| OTel SDK/Core/Resource/Web | 2.7.1 |
| OTel NodeSDK、Logs、exporter、instrumentation | 0.218.0 |
| PG / Pino / ioredis 插件 | 0.70.0 / 0.64.0 / 0.66.0 |
| web-vitals | 5.1.0 |
| Collector / OpenObserve | 0.163.2 / v1.1.2；Collector 镜像 digest `sha256:7f22d2a6748110ffb6a59bc0df448bccbf501cdb667d610ede4c61d3863d5849`，配置验证通过；OO 真实联调待验收 |

依赖固定进 bun.lock；根 override 使官方 Elysia 插件复用同一 NodeSDK/instrumentation 版本。按文档允许的显式插件装配使用同一允许列表，不安装会引入无关探测器的聚合包。

## 3. 实施适配

1. Bun 直接 ESM import 的 Pino 自动补丁探针导出0条；标准 require hook 返回值写回 cache 后导出1条。生产 `--splitting --packages=external` 并显式外置 logger 子路径，保持动态加载边界，携带安装结果和 workspace。源码和同形 bundle 探针已验证三信号、PG/ioredis失败调用链、唯一日志、Trace关联和脱敏。
2. Pino 标准数字级别用于 OTel severity，附加 `levelLabel` 供现有 Observer 投影；本地文件仍保留，旧同步关闭日志并入统一入口。
3. 官方 HTTP 计时不重复；测试安装真实 AsyncLocalStorageContextManager 后验证 AlwaysOffSampler 下仍完整计数。
4. PG 插件锁定版本提供 count/pending 但没有 max；宿主只补缺失 max 仪表，不重复计数。
5. 恢复计时从 host-session 已有历史提交编排提取为 `commit-host-history.ts`，保持单文件规模，不增加历史扫描。测试 preload 会提前载业务模块，因此仪表语义测试用独立进程先装 Provider。
6. 浏览器入口拒绝所有压缩而不是解压，从而保证解码后同样不超过1MiB；仅当前站点已认证用户可转发。
7. 浏览器原始 error message/stack 可能含正文，初版保守只导出有限类型；Collector 再删不可信日志正文、Span事件和任意身份。
8. 独立验证修复：`/otel` 的 Origin 信任基准改为宿主 `RCS_BASE_URL`（生产必须为单公开 HTTPS origin；缺失/非法/localhost 告警并 fail-closed），转发头不参与；代理增加每用户 2 个在飞上限，速率窗口滚动保留在飞计数。所有自定义 Histogram 使用显式桶：秒最长 3600s、快照字节最大 256MiB、LCP/INP 毫秒、CLS 无单位。宿主关闭改为 5s 优雅排空后不再重复 stop，完成宿主清理再退出；空 endpoint 按未配置处理；所有空白 `OTEL_*` 回退默认值；首次连接不计 reconnect。

## 4. 验证记录与边界

验证原始命令、结果与未验收项由本次最终交付报告记录。已执行独立安装、server/web/packages类型检查、前端生产构建、相关行为回归与Compose解析。完整 fastcheck/precheck 的最终状态以报告为准，不能以局部成功替代全量门禁。

A01–A26 必须记录真实 Collector/OO 输入、查询和版本证据；没有真实数据就不宣称通过。看板映射为候选，尚未核实目标 OO 直方图映射、P95与告警运行。生产镜像及主机挂载、故障/性能演练仍需部署环境 owner 验收。

稳定事实见 [架构契约](../arch/observability.md)，部署/升级/备份/回滚见 [运维手册](../operations/observability.md)。
