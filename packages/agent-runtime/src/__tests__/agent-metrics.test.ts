import { expect, test } from "bun:test";

// 与生产入口一致先安装 Provider，迟到和重复结束信号不得重复累计。
test("Agent 运行结束幂等且指标不带实例标签", async () => {
  const script = `
    import assert from 'node:assert/strict';
    import {metrics} from '@opentelemetry/api';
    import {MeterProvider,MetricReader} from '@opentelemetry/sdk-metrics';
    class Reader extends MetricReader { async onForceFlush() {} async onShutdown() {} }
    const reader=new Reader(); const provider=new MeterProvider({readers:[reader]});
    metrics.setGlobalMeterProvider(provider);
    const {beginAgentRun,agentRunReady,finishAgentRun}=await import('./packages/agent-runtime/src/server/services/agent-metrics');
    beginAgentRun('private-instance',1); agentRunReady('private-instance','peri');
    finishAgentRun('private-instance','failure',0); finishAgentRun('private-instance','success',1); finishAgentRun('private-instance','failure',1);
    const data=(await reader.collect()).resourceMetrics.scopeMetrics.flatMap(s=>s.metrics);
    const run=data.find(m=>m.descriptor.name==='fenix.agent.runs').dataPoints[0];
    assert.equal(run.value,1); assert.deepEqual(run.attributes,{engine:'peri',result:'success'});
    assert.equal(JSON.stringify(data).includes('private-instance'),false);
    await provider.shutdown();
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd: new URL("../../../../", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  expect({ exitCode: await proc.exited, stderr }).toEqual({ exitCode: 0, stderr: "" });
});
