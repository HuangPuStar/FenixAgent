/** Resource values retain the platform's cores / MB / GB / device units. */
export interface Resources {
  cpu: number;
  memoryMb: number;
  diskGb: number;
  gpuCount: number;
}
export const dimensions = ["cpu", "memoryMb", "diskGb", "gpuCount"] as const;
/** Convert finite decimal numbers to exact integer coefficients for arithmetic. */
function decimal(value: number): [bigint, number] {
  const [mantissa, exponent = "0"] = String(value).split("e");
  const [whole = "0", fraction = ""] = mantissa!.split(".");
  return [BigInt(whole + fraction), fraction.length - Number(exponent)];
}
/** Sum decimals without binary floating point accumulation. */
export function decimalSum(values: number[]): number {
  const parts = values.map(decimal);
  const scale = Math.max(0, ...parts.map((p) => p[1]));
  const result = parts.reduce((sum, [value, s]) => sum + value * 10n ** BigInt(scale - s), 0n);
  return Number(`${result}e-${scale}`);
}
/** Sum reservations in the common resource units. */
export function sumResources(values: Resources[]): Resources {
  return Object.fromEntries(
    dimensions.map((key) => [key, decimalSum(values.map((value) => value[key]))]),
  ) as unknown as Resources;
}
/** Compare exact decimal sums against a node budget. */
export function resourceFits(capacity: Resources, allocated: Resources | Resources[]): boolean {
  const values = Array.isArray(allocated) ? allocated : [allocated];
  return dimensions.every((key) => {
    const parts = [decimal(capacity[key]), ...values.map((value) => decimal(value[key]))];
    const scale = Math.max(0, ...parts.map((part) => part[1]));
    const integers = parts.map(([value, s]) => value * 10n ** BigInt(scale - s));
    return integers.slice(1).reduce((sum, value) => sum + value, 0n) <= integers[0]!;
  });
}
/** Reject malformed and non-finite resource requests. */
export function validateResources(value: Resources): void {
  for (const key of dimensions)
    if (!Number.isFinite(value?.[key]) || value[key] < (key === "gpuCount" ? 0 : Number.MIN_VALUE))
      throw new Error(`invalid ${key}`);
  if (!Number.isInteger(value.gpuCount)) throw new Error("invalid gpuCount");
}
