import { CheckCircle, Clock, Loader, Play, RefreshCw, ShieldCheck, XCircle } from "lucide-react";

export function EventIcon({ type }: { type: string }) {
  if (type.startsWith("dag.")) {
    const isOk = type === "dag.completed";
    return isOk ? (
      <CheckCircle size={11} style={{ color: "#22c55e", flexShrink: 0, marginTop: 1 }} />
    ) : type === "dag.cancelled" ? (
      <XCircle size={11} style={{ color: "#94a3b8", flexShrink: 0, marginTop: 1 }} />
    ) : (
      <Play size={11} style={{ color: "#3b82f6", flexShrink: 0, marginTop: 1 }} />
    );
  }
  if (type.includes("failed")) return <XCircle size={11} style={{ color: "#ef4444", flexShrink: 0, marginTop: 1 }} />;
  if (type.includes("completed"))
    return <CheckCircle size={11} style={{ color: "#22c55e", flexShrink: 0, marginTop: 1 }} />;
  if (type.includes("started")) return <Loader size={11} style={{ color: "#3b82f6", flexShrink: 0, marginTop: 1 }} />;
  if (type.includes("retrying"))
    return <RefreshCw size={11} style={{ color: "#f59e0b", flexShrink: 0, marginTop: 1 }} />;
  if (type.includes("audit"))
    return <ShieldCheck size={11} style={{ color: "#f59e0b", flexShrink: 0, marginTop: 1 }} />;
  return <Clock size={11} style={{ color: "#94a3b8", flexShrink: 0, marginTop: 1 }} />;
}
