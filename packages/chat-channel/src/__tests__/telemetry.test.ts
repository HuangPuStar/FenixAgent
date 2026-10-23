import { expect, test } from "bun:test";

// 独立进程先装 Provider 再加载业务模块，避免仓库 preload 提前创建 No-op 仪表。
test("同步指标复用活跃诊断和既有 ACK/快照测量", async () => {
  const script = `
    import assert from 'node:assert/strict';
    import {metrics} from '@opentelemetry/api';
    import {MeterProvider, MetricReader} from '@opentelemetry/sdk-metrics';
    class Reader extends MetricReader { async onForceFlush() {} async onShutdown() {} }
    const reader = new Reader();
    const provider = new MeterProvider({readers:[reader]});
    metrics.setGlobalMeterProvider(provider);
    const {registerSyncDiagnostics} = await import('./packages/chat-channel/src/sync/metrics');
    const {createAckTimeoutTracker} = await import('./packages/chat-channel/src/sync/provider/ack-timeout');
    const {reportSnapshotCasMetric} = await import('./packages/chat-channel/src/persist/snapshot-config');
    const {createIngressFailureReporter} = await import('./packages/chat-channel/src/sync/runtime/ingress-failure-reporter');
    let bytes = 512, now = 1000;
    const unregister = registerSyncDiagnostics(()=>({connected:true,outstandingBytes:bytes,pendingTasks:2,unackedDeliveries:1}));
    const ack = createAckTimeoutTracker({clock:{now:()=>now},ackDeadlineMs:1000});
    ack.track('delivery-1','epoch-1'); now+=250; ack.settle('delivery-1'); ack.settle('delivery-1');
    const failure = createIngressFailureReporter({report(){}, now:()=>now}); failure.report(new Error('failed'));
    reportSnapshotCasMetric(undefined,'private-doc',512,2,20,true);
    const collect = async()=> (await reader.collect()).resourceMetrics.scopeMetrics.flatMap(s=>s.metrics);
    let data = await collect();
    const value = name => data.find(m=>m.descriptor.name===name)?.dataPoints[0]?.value;
    assert.equal(value('fenix.sync.outstanding.bytes'),512);
    assert.equal(value('fenix.sync.ack.duration').count,1);
    assert.equal(value('fenix.sync.ack.duration').sum,0.25);
    assert.equal(value('fenix.snapshot.size').sum,512);
    bytes=0; data=await collect(); assert.equal(value('fenix.sync.outstanding.bytes'),0);
    assert.equal(value('fenix.sync.failures'),1);
    unregister(); data=await collect(); assert.equal(value('fenix.sync.connections'),0);
    assert.equal(JSON.stringify(data).includes('private-doc'),false);
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
