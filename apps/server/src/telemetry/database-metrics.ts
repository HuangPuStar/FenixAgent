import { metrics } from "@opentelemetry/api";

/** 锁定的 PG 插件提供 count/pending，但未提供 max；只补该缺失仪表，不重复池连接计数。 */
export function observeDatabasePoolMaximum(max: number): void {
  metrics
    .getMeter("fenix-server")
    .createObservableGauge("db.client.connection.max", { unit: "{connection}" })
    .addCallback((result) => {
      result.observe(max, { "db.system.name": "postgresql" });
    });
}
