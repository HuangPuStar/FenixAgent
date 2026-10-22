import type { Meter } from "@opentelemetry/api";

/** 浏览器恢复秒：覆盖首屏历史恢复与慢网络。 */
export const WEB_SECONDS_HISTOGRAM_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 0.9, 2.5, 5, 10, 30, 60, 300, 600, 1800, 3600,
];
export const WEB_LCP_MILLISECONDS_BUCKETS = [100, 250, 500, 1000, 1500, 2500, 4000, 6000, 10000];
export const WEB_INP_MILLISECONDS_BUCKETS = [50, 100, 200, 300, 500, 800, 1200, 2000, 5000];
export const WEB_CLS_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.4, 1, 2];

/** SDK 与分桶测试共用同一组定义，避免测试复制一份漂移的桶。 */
export function createWebPerformanceInstruments(meter: Meter) {
  return {
    lcp: meter.createHistogram("fenix.web.lcp", {
      unit: "ms",
      advice: { explicitBucketBoundaries: WEB_LCP_MILLISECONDS_BUCKETS },
    }),
    inp: meter.createHistogram("fenix.web.inp", {
      unit: "ms",
      advice: { explicitBucketBoundaries: WEB_INP_MILLISECONDS_BUCKETS },
    }),
    cls: meter.createHistogram("fenix.web.cls", {
      unit: "1",
      advice: { explicitBucketBoundaries: WEB_CLS_BUCKETS },
    }),
  };
}

export const browserSecondsAdvice = { explicitBucketBoundaries: WEB_SECONDS_HISTOGRAM_BUCKETS };
