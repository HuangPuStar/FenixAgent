# @fenix-ce/observability

定义业务模块使用的 `Logger` 与 `AuditRecorder` 端口。模块不能直接写文件、读取日志平台配置或记录 secret；`apps/server` 选择 stdout、日志平台和审计存储实现。
