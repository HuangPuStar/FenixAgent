import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "../docker/openobserve/assets");
const selector = 'deployment_environment_name=~"$environment",service_name=~"$service"';
const dashboards: Record<string, { title: string; panels: [string, string, string][] }> = {
  platform: {
    title: "Fenix 平台总览",
    panels: [
      [
        "HTTP 请求量",
        `sum(rate(http_server_request_duration_count{${selector}}[5m]))`,
        "http_server_request_duration_count",
      ],
      [
        "HTTP 5xx 比例",
        `sum(rate(http_server_request_duration_count{${selector},http_response_status_code=~"5.."}[5m])) / sum(rate(http_server_request_duration_count{${selector}}[5m]))`,
        "http_server_request_duration_count",
      ],
      [
        "HTTP P95 秒",
        `histogram_quantile(0.95,sum by(le,http_route)(rate(http_server_request_duration_bucket{${selector}}[5m])))`,
        "http_server_request_duration_bucket",
      ],
      ["Agent 活跃实例", `sum by(engine,state)(fenix_agent_active{${selector}})`, "fenix_agent_active"],
      [
        "PG 客户端 P95",
        `histogram_quantile(0.95,sum by(le)(rate(db_client_operation_duration_bucket{${selector}}[5m])))`,
        "db_client_operation_duration_bucket",
      ],
      [
        "PG 连接等待",
        `sum(db_client_connection_pending_requests{${selector}})`,
        "db_client_connection_pending_requests",
      ],
    ],
  },
  infrastructure: {
    title: "Fenix 主机与容器",
    panels: [
      ["主机 CPU", `sum by(host_id)(rate(system_cpu_time{${selector},state!="idle"}[5m]))`, "system_cpu_time"],
      ["主机内存", `sum by(host_id,state)(system_memory_usage{${selector}})`, "system_memory_usage"],
      ["磁盘剩余", `system_filesystem_usage{${selector},state="free"}`, "system_filesystem_usage"],
      ["容器内存", `container_memory_usage_total{${selector}}`, "container_memory_usage_total"],
      ["PG 后端", `postgresql_backends{${selector}}`, "postgresql_backends"],
      ["Redis 内存", `redis_memory_used{${selector}}`, "redis_memory_used"],
    ],
  },
  synchronization: {
    title: "Fenix 同步与恢复",
    panels: [
      ["连接数", `sum(fenix_sync_connections{${selector}})`, "fenix_sync_connections"],
      ["待处理任务", `sum(fenix_sync_queue_tasks{${selector}})`, "fenix_sync_queue_tasks"],
      ["未确认字节", `sum(fenix_sync_outstanding_bytes{${selector}})`, "fenix_sync_outstanding_bytes"],
      ["未确认投递", `sum(fenix_sync_unacked_deliveries{${selector}})`, "fenix_sync_unacked_deliveries"],
      [
        "ACK P95 秒",
        `histogram_quantile(0.95,sum by(le)(rate(fenix_sync_ack_duration_bucket{${selector}}[5m])))`,
        "fenix_sync_ack_duration_bucket",
      ],
      [
        "断连原因",
        `sum by(reason)(rate(fenix_sync_disconnects_total{${selector}}[5m]))`,
        "fenix_sync_disconnects_total",
      ],
      [
        "恢复结果",
        `sum by(result)(rate(fenix_history_restore_duration_count{${selector}}[5m]))`,
        "fenix_history_restore_duration_count",
      ],
      [
        "快照持久化",
        `sum by(result)(rate(fenix_snapshot_persist_duration_count{${selector}}[5m]))`,
        "fenix_snapshot_persist_duration_count",
      ],
    ],
  },
  collection: {
    title: "Fenix 采集链路",
    panels: [
      [
        "队列占用",
        `otelcol_exporter_queue_size{${selector}} / otelcol_exporter_queue_capacity{${selector}}`,
        "otelcol_exporter_queue_size",
      ],
      [
        "发送失败 Span",
        `sum(rate(otelcol_exporter_send_failed_spans_total{${selector}}[5m]))`,
        "otelcol_exporter_send_failed_spans_total",
      ],
      [
        "发送失败日志",
        `sum(rate(otelcol_exporter_send_failed_log_records_total{${selector}}[5m]))`,
        "otelcol_exporter_send_failed_log_records_total",
      ],
      [
        "接收拒绝指标",
        `sum(rate(otelcol_receiver_refused_metric_points_total{${selector}}[5m]))`,
        "otelcol_receiver_refused_metric_points_total",
      ],
      [
        "指标发送量",
        `sum(rate(otelcol_exporter_sent_metric_points_total{${selector}}[5m]))`,
        "otelcol_exporter_sent_metric_points_total",
      ],
    ],
  },
};

/** 候选映射集中记录；运行验收后按实际 OO 字段统一修正，不改应用 OTel 名称。 */
export async function generateObservabilityAssets(): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const [id, dashboard] of Object.entries(dashboards)) {
    const services =
      id === "infrastructure"
        ? "fenix-host|fenix-container|fenix-postgresql|fenix-redis"
        : id === "collection"
          ? "fenix-collector"
          : "fenix-server";
    const variables = [
      {
        name: "environment",
        label: "环境",
        type: "custom",
        value: "production",
        options: [
          { label: "production", value: "production" },
          { label: "staging", value: "staging" },
          { label: "development", value: "development" },
        ],
      },
      {
        name: "service",
        label: "服务",
        type: "custom",
        value: services,
        options: services.split("|").map((value) => ({ label: value, value })),
      },
    ];
    const panels = dashboard.panels.map(([title, query, stream], index) => ({
      id: `Panel_${id}_${index}`,
      type: "line",
      title,
      description: "候选 OTLP 映射；缺数据保持缺数据，不显示为零。",
      config: { show_legends: true, legends_position: null },
      queryType: "promql",
      queries: [
        {
          query,
          customQuery: true,
          fields: { stream, stream_type: "metrics", x: [], y: [], z: [], filter: [] },
          config: { promql_legend: "{service_name}" },
        },
      ],
      layout: { x: (index % 2) * 6, y: Math.floor(index / 2) * 6, w: 6, h: 6, i: index },
    }));
    await Bun.write(
      join(root, `${id}.dashboard.json`),
      `${JSON.stringify({ version: 2, dashboardId: `fenix-${id}`, title: dashboard.title, description: "目标 OO v1.1.2，指标映射需 A24 实测确认", role: "", owner: "", created: "2026-10-22T00:00:00.000Z", panels, variables: { list: variables }, defaultDatetimeDuration: { type: "relative", relativeTimePeriod: "1h" } }, null, 2)}\n`,
    );
  }
}

if (import.meta.main) await generateObservabilityAssets();
