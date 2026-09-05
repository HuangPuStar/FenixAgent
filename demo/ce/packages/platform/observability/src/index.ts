/** 业务模块消费的结构化日志端口；具体 stdout/日志平台实现由 app 注入。 */
export interface Logger {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** 不可与运行日志混淆的业务审计端口。 */
export interface AuditRecorder {
  record(event: { action: string; actorId: string; resourceId?: string }): Promise<void>;
}

/** demo 输出 JSON，生产实现必须在边界处脱敏。 */
export const demoLogger: Logger = {
  info(event, fields = {}) {
    console.info(JSON.stringify({ level: "info", event, ...fields }));
  },
  error(event, fields = {}) {
    console.error(JSON.stringify({ level: "error", event, ...fields }));
  },
};
