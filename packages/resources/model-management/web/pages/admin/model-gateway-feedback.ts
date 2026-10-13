/** 模型网关连接检查的用户反馈语义，避免把连接失败误显示为普通状态更新。 */
export function getModelGatewayConnectionFeedback(status: {
  status: "synced" | "pending" | "unknown";
  models?: Array<unknown>;
  error?: string;
}) {
  if (status.status === "unknown") {
    return {
      level: "error" as const,
      translationKey: "modelGateway.connectionCheck.failed",
      values: { message: status.error ?? "—" },
    };
  }
  return {
    level: "success" as const,
    translationKey: "modelGateway.connectionCheck.succeeded",
    values: { count: status.models?.length ?? 0 },
  };
}
