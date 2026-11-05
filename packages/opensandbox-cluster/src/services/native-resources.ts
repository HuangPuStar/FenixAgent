/** Observed native limits in Cluster units; missing or unsupported values stay unknown. */
export interface NativeResources {
  cpu: number | null;
  memoryMb: number | null;
  diskGb: number | null;
  gpuCount: number | null;
}

function quantity(value: unknown, unit: "cpu" | "memory" | "disk" | "gpu"): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const match = /^(\d+(?:\.\d+)?)([A-Za-z]*)$/.exec(String(value));
  if (!match) return null;
  const number = Number(match[1]);
  const suffix = match[2];
  let result: number;
  if (unit === "cpu") result = suffix === "m" ? number / 1000 : suffix === "" ? number : NaN;
  else if (unit === "gpu") result = suffix === "" && Number.isInteger(number) ? number : NaN;
  else {
    const multipliers: Record<string, number> = {
      "": 1,
      Ki: 2 ** 10,
      Mi: 2 ** 20,
      Gi: 2 ** 30,
      Ti: 2 ** 40,
      K: 1e3,
      M: 1e6,
      G: 1e9,
      T: 1e12,
    };
    result = (number * (multipliers[suffix] ?? NaN)) / (unit === "memory" ? 2 ** 20 : 2 ** 30);
  }
  return Number.isFinite(result) && result >= 0 ? result : null;
}

/** Read optional OpenSandbox resourceLimits without imposing new validation on proxy callers. */
export function nativeResources(body: unknown): NativeResources | undefined {
  if (!body || typeof body !== "object" || !("resourceLimits" in body)) return;
  const limits = body.resourceLimits;
  if (!limits || typeof limits !== "object") return;
  const fields = limits as Record<string, unknown>;
  return {
    cpu: quantity(fields.cpu, "cpu"),
    memoryMb: quantity(fields.memory, "memory"),
    diskGb: quantity(fields.disk, "disk"),
    gpuCount: quantity(fields.gpu, "gpu"),
  };
}
