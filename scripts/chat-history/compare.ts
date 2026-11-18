import { parseArgs } from "node:util";
import { z } from "zod/v4";

const duration = z.number().finite().nonnegative().nullable();
const socket = z.object({
  receivedBytes: z.number().int().nonnegative(),
  sentBytes: z.number().int().nonnegative().optional(),
});
/** 布局必须相同且样式生效，才能比较正文排版和交互成本。 */
export const loadSampleLayoutSchema = z
  .object({
    viewportWidth: z.number().positive(),
    viewportHeight: z.number().positive(),
    contentWidth: z.number().positive(),
    contentDisplay: z.string(),
  })
  .nullable();

/** 脱敏原始样本；失败保留在样本集合及失败率分母中。 */
export const loadSampleSchema = z.object({
  version: z.string().min(1),
  pair: z.number().int().nonnegative(),
  scenario: z.enum(["refresh", "reopen", "switch"]),
  entryCount: z.number().int().positive(),
  cacheState: z.enum(["hot", "cold-ttl", "cold-eviction", "cold-generation", "cold-restart"]),
  fixtureDigest: z.string().min(1),
  firstVisibleMs: duration,
  interactiveMs: duration,
  earlierMs: duration,
  failure: z.enum(["timeout", "browser-error", "content-mismatch", "measurement-error"]).nullable(),
  contentVerified: z.boolean(),
  layout: loadSampleLayoutSchema,
  sockets: z.object({ state: socket, content: socket }),
  stages: z.record(z.string(), z.number().finite().nonnegative().nullable()),
  counters: z.record(z.string(), z.number().finite().nonnegative()).optional(),
});

/** 一个版本在某个固定场景中的实际浏览器加载观测。 */
export type LoadSample = z.infer<typeof loadSampleSchema>;
/** 不以平均值掩盖长尾的统计结果。 */
export interface DurationStatistics {
  median: number;
  p95: number;
  max: number;
}
/** 一个场景的完整样本统计。 */
export interface LoadStatistics {
  count: number;
  failureRate: number;
  firstVisibleMs: DurationStatistics | null;
  interactiveMs: DurationStatistics | null;
  earlierMs: DurationStatistics | null;
}
/** 同条件配对对照，issues 只含类别，不含外部错误消息或凭据。 */
export interface LoadComparison {
  pass: boolean;
  issues: string[];
  groups: Array<{
    key: string;
    pass: boolean;
    issues: string[];
    /** 全部请求的失败率及所有成功请求的描述统计，保留未能配对的成功长尾。 */
    baseline: LoadStatistics;
    candidate: LoadStatistics;
    /** 延迟门槛只比较双方均完成同一轮次的样本，不能把缺失耗时当成零。 */
    paired: { baseline: LoadStatistics; candidate: LoadStatistics };
  }>;
}

const EARLIER_REGRESSION_BUDGET_MS = 10;
const METRICS = ["firstVisibleMs", "interactiveMs", "earlierMs"] as const;

function stats(values: number[]): DurationStatistics | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    max: sorted.at(-1)!,
  };
}

function summarize(samples: readonly LoadSample[]): LoadStatistics {
  const complete = samples.filter((sample) => sample.failure === null && sample.contentVerified);
  const metric = (key: (typeof METRICS)[number]) =>
    stats(complete.flatMap((sample) => (sample[key] === null ? [] : [sample[key]])));
  return {
    count: samples.length,
    failureRate: samples.length ? samples.filter((sample) => sample.failure !== null).length / samples.length : 1,
    firstVisibleMs: metric("firstVisibleMs"),
    interactiveMs: metric("interactiveMs"),
    earlierMs: metric("earlierMs"),
  };
}

function group(samples: readonly LoadSample[]): Map<string, LoadSample[]> {
  const groups = new Map<string, LoadSample[]>();
  for (const sample of samples) {
    const key = JSON.stringify([sample.scenario, sample.entryCount, sample.cacheState]);
    const rows = groups.get(key) ?? [];
    rows.push(sample);
    groups.set(key, rows);
  }
  return groups;
}

/** 只有成功且验证完整的观测才具有可比较的末页和翻页耗时。 */
function isCompleteSample(sample: LoadSample | undefined): boolean {
  return (
    sample !== undefined &&
    sample.failure === null &&
    sample.contentVerified &&
    sample.layout?.contentDisplay === "flex" &&
    METRICS.every((metric) => sample[metric] !== null)
  );
}

/** 对每组分别执行完整性、配对、失败率及中位数/P95 门槛，不混合冷/热结果。 */
export function compareLoadSamples(baseline: readonly LoadSample[], candidate: readonly LoadSample[]): LoadComparison {
  const validBaseline = z.array(loadSampleSchema).safeParse(baseline);
  const validCandidate = z.array(loadSampleSchema).safeParse(candidate);
  if (!validBaseline.success || !validCandidate.success) return { pass: false, issues: ["invalid-sample"], groups: [] };
  const before = group(validBaseline.data);
  const after = group(validCandidate.data);
  const keys = new Set([...before.keys(), ...after.keys()]);
  const groups: LoadComparison["groups"] = [];
  for (const key of keys) {
    const left = before.get(key) ?? [];
    const right = after.get(key) ?? [];
    const issues: string[] = [];
    if ([...left, ...right].some((row) => row.failure === "measurement-error")) issues.push("measurement-unavailable");
    const pairs = (rows: LoadSample[]) => new Set(rows.map((row) => row.pair));
    const leftPairs = pairs(left);
    const rightPairs = pairs(right);
    if (left.length < 20 || right.length < 20) issues.push("insufficient-samples");
    if (leftPairs.size !== left.length || rightPairs.size !== right.length) issues.push("duplicate-pair");
    if (leftPairs.size !== rightPairs.size || [...leftPairs].some((pair) => !rightPairs.has(pair)))
      issues.push("unpaired-samples");
    const rightByPair = new Map(right.map((row) => [row.pair, row]));
    if (left.some((row) => row.fixtureDigest !== rightByPair.get(row.pair)?.fixtureDigest))
      issues.push("fixture-mismatch");
    if ([...left, ...right].some((row) => row.failure === null && row.layout?.contentDisplay !== "flex"))
      issues.push("invalid-layout");
    if (
      left.some(
        (row) =>
          row.failure === null &&
          rightByPair.get(row.pair)?.failure === null &&
          JSON.stringify(row.layout) !== JSON.stringify(rightByPair.get(row.pair)?.layout),
      )
    )
      issues.push("layout-mismatch");
    if (
      [...left, ...right].some(
        (row) => row.failure === null && (!row.contentVerified || METRICS.some((metric) => row[metric] === null)),
      )
    )
      issues.push("incomplete-content-or-timing");
    const b = summarize(left);
    const c = summarize(right);
    const completeLeft = left.filter((row) => isCompleteSample(row) && isCompleteSample(rightByPair.get(row.pair)));
    const completeRight = completeLeft.map((row) => rightByPair.get(row.pair)!);
    const paired = { baseline: summarize(completeLeft), candidate: summarize(completeRight) };
    if (completeLeft.length < 20) issues.push("insufficient-complete-pairs");
    if (c.failureRate > b.failureRate) issues.push("failure-rate-regressed");
    for (const metric of METRICS) {
      const l = paired.baseline[metric];
      const r = paired.candidate[metric];
      if (l === null || r === null) issues.push(`${metric}:no-complete-samples`);
      else if (metric === "earlierMs") {
        if (r.median > l.median + EARLIER_REGRESSION_BUDGET_MS || r.p95 > l.p95 + EARLIER_REGRESSION_BUDGET_MS)
          issues.push(`${metric}:regressed`);
      } else if (r.median >= l.median || r.p95 >= l.p95) {
        issues.push(`${metric}:${r.median > l.median || r.p95 > l.p95 ? "regressed" : "not-improved"}`);
      }
    }
    groups.push({ key, pass: issues.length === 0, issues, baseline: b, candidate: c, paired });
  }
  return {
    pass: groups.length > 0 && groups.every((row) => row.pass),
    issues: groups.length ? [] : ["no-samples"],
    groups,
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { baseline: { type: "string" }, candidate: { type: "string" } },
  });
  if (!values.baseline || !values.candidate) throw new Error("--baseline and --candidate are required");
  const result = compareLoadSamples(await Bun.file(values.baseline).json(), await Bun.file(values.candidate).json());
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.pass ? 0 : 1;
}
