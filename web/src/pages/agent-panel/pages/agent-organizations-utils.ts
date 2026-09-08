import type { MachineRecord } from "@/src/api/registry";

/** Derive a stable URL slug without creating a second server-side validation contract. */
export function nameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

export function readDefaultMachineId(metadata: Record<string, unknown> | null | undefined): string {
  const defaultEngine = metadata?.defaultEngine;
  if (!defaultEngine || typeof defaultEngine !== "object") return "local";
  const machineId = (defaultEngine as { machineId?: unknown }).machineId;
  return typeof machineId === "string" && machineId.length > 0 ? machineId : "local";
}

export function canOperateMachine(
  machine: MachineRecord,
  organizationId: string | null,
  currentUserId: string | null,
  canManage: boolean,
): boolean {
  if (!canManage || !organizationId || !currentUserId) return false;
  if (machine.organizationId !== organizationId) return false;
  return machine.userId === null || machine.userId === currentUserId;
}

export function parseLabels(value: string): string[] {
  return value
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}
