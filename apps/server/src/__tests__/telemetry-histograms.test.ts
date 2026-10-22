import { expect, test } from "bun:test";

// 自定义 Histogram 必须使用秒/字节/毫秒/CLS 各自显式桶，默认 [0,5,10] 会丢失亚秒与体积分辨率。
test("自定义 Histogram 的桶边界与落桶计数正确", async () => {
  const script = `
    import assert from 'node:assert/strict';
    import {metrics} from '@opentelemetry/api';
    import {MeterProvider,MetricReader} from '@opentelemetry/sdk-metrics';
    class Reader extends MetricReader { async onForceFlush() {} async onShutdown() {} }
    const reader = new Reader();
    const provider = new MeterProvider({readers:[reader]});
    metrics.setGlobalMeterProvider(provider);
    const chat = await import('./packages/chat-channel/src/sync/metrics');
    assert.equal(chat.SYNC_SECONDS_HISTOGRAM_BUCKETS.at(-1), 3600);
    assert.equal(chat.SNAPSHOT_BYTES_HISTOGRAM_BUCKETS.at(-1), 268435456);
    chat.syncAckDuration.record(0.25, {channel:'sync',message:'delivery'});
    chat.snapshotSize.record(20480, {storage:'redis'});
    chat.historyRestoreDuration.record(0.9, {mode:'stable_history',result:'success'});
    chat.snapshotPersistDuration.record(0.05, {storage:'redis',result:'success'});
    const agent = await import('./packages/agent-runtime/src/server/services/agent-metrics');
    assert.equal(agent.AGENT_SECONDS_HISTOGRAM_BUCKETS.at(-1), 3600);
    agent.beginAgentRun('bucket-probe', 1);
    agent.finishAgentRun('bucket-probe', 'success', 1);
    const web = await import('./packages/web-runtime/web/telemetry/buckets');
    assert.equal(web.WEB_SECONDS_HISTOGRAM_BUCKETS.at(-1), 3600);
    const vital = web.createWebPerformanceInstruments(metrics.getMeter('web-bucket-probe'));
    vital.lcp.record(1200); vital.inp.record(250); vital.cls.record(0.2);
    const events = await import('./packages/web-runtime/web/telemetry/events');
    events.activateBrowserTelemetry();
    events.recordBrowserEvent('history_ready', 900);
    const data = (await reader.collect()).resourceMetrics.scopeMetrics.flatMap(s=>s.metrics);
    const byName = name => data.find(m=>m.descriptor.name===name);
    const bucket = (name, expected, value) => {
      const point = byName(name).dataPoints[0];
      assert.deepEqual(point.value.buckets.boundaries, expected);
      const boundaries = point.value.buckets.boundaries;
      const index = boundaries.findIndex(boundary => value <= boundary);
      assert.equal(point.value.buckets.counts[index === -1 ? boundaries.length : index], 1, name);
    };
    bucket('fenix.sync.ack.duration', chat.SYNC_SECONDS_HISTOGRAM_BUCKETS, 0.25);
    bucket('fenix.history.restore.duration', chat.SYNC_SECONDS_HISTOGRAM_BUCKETS, 0.9);
    bucket('fenix.snapshot.persist.duration', chat.SYNC_SECONDS_HISTOGRAM_BUCKETS, 0.05);
    bucket('fenix.snapshot.size', chat.SNAPSHOT_BYTES_HISTOGRAM_BUCKETS, 20480);
    const agentRun = byName('fenix.agent.run.duration').dataPoints[0];
    assert.deepEqual(agentRun.value.buckets.boundaries, agent.AGENT_SECONDS_HISTOGRAM_BUCKETS);
    assert.equal(agentRun.value.count, 1);
    assert.equal(agentRun.value.buckets.counts.reduce((sum, count) => sum + count, 0), 1);
    assert.deepEqual(byName('fenix.agent.start.duration').dataPoints[0].value.buckets.boundaries, agent.AGENT_SECONDS_HISTOGRAM_BUCKETS);
    bucket('fenix.web.lcp', web.WEB_LCP_MILLISECONDS_BUCKETS, 1200);
    bucket('fenix.web.inp', web.WEB_INP_MILLISECONDS_BUCKETS, 250);
    bucket('fenix.web.cls', web.WEB_CLS_BUCKETS, 0.2);
    bucket('fenix.web.history.duration', web.WEB_SECONDS_HISTOGRAM_BUCKETS, 0.9);
    await provider.shutdown();
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd: new URL("../../../../", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  expect({ exitCode: await proc.exited, stderr }).toEqual({ exitCode: 0, stderr: "" });
}, 30_000);
