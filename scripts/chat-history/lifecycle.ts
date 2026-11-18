import { z } from "zod/v4";
import type { LoadSample } from "./compare";

/** 每组描述目标内容的缓存状态；ACP 会话切换必然创建新 generation。 */
export interface BenchmarkCase {
  entryCount: number;
  scenario: LoadSample["scenario"];
  cacheState: LoadSample["cacheState"];
}

/** 仅组合可实际到达的目标状态，避免把切换前的缓存命中误报为切换后热命中。 */
export function createBenchmarkCases(
  entries: readonly number[],
  scenarios: readonly LoadSample["scenario"][],
  states: readonly LoadSample["cacheState"][],
): BenchmarkCase[] {
  return entries.flatMap((entryCount) =>
    scenarios.flatMap((scenario) =>
      states
        .filter((cacheState) => scenario !== "switch" || cacheState === "cold-generation")
        .map((cacheState) => ({ entryCount, scenario, cacheState })),
    ),
  );
}

/** 受控本地基准服务完成真实失效后才开始测量；失败不得退回普通刷新并贴冷缓存标签。 */
export async function prepareColdHistory(
  controlUrl: string,
  entryCount: number,
  state: LoadSample["cacheState"],
): Promise<void> {
  if (state === "hot") return;
  const path =
    state === "cold-generation" ? `/reset?entries=${entryCount}` : `/prepare-cold?entries=${entryCount}&mode=${state}`;
  const response = await fetch(`${controlUrl}${path}`, { method: "POST", signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error("Cold history preparation failed");
  if (state === "cold-generation") {
    z.object({ reset: z.literal(true) }).parse(await response.json());
    return;
  }
  const prepared = z
    .object({ prepared: z.literal(true), mode: z.string(), previousPid: z.number().optional() })
    .parse(await response.json());
  if (prepared.mode !== state) throw new Error("Cold history preparation mode differs");
  if (state !== "cold-restart") return;
  if (prepared.previousPid === undefined) throw new Error("Restart identity is missing");
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const ready = await fetch(`${controlUrl}/boot`, { signal: AbortSignal.timeout(1000) });
      const boot = z.object({ pid: z.number() }).parse(await ready.json());
      if (ready.ok && boot.pid !== prepared.previousPid) return;
    } catch {
      // 重启窗口内连接不可用是准备过程，截止时间内必须观察到新进程才允许采样。
    }
    await Bun.sleep(100);
  }
  throw new Error("Benchmark service did not restart");
}
