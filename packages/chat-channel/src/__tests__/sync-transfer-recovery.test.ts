import { expect, test } from "bun:test";
import { liveText, transferFixture, writeText } from "./sync-transfer-fixture";

for (const mode of ["bufferedAmount", "send=false"] as const) {
  // 三块同时订阅遭遇背压后，必须全部恢复，不能只交付最后一块并清空账本。
  test(`B08：${mode} 解除后全部基线到达并 ACK`, async () => {
    const fixture = await transferFixture();
    try {
      const client = await fixture.connect();
      const imported = await client.host.importHistory({
        acpSessionId: "ses-transfer",
        records: Array.from({ length: 3 }, (_, index) => ({
          value: String(index).repeat(120 * 1024),
          meta: { kind: "text_part", entryId: `entry-${index}`, contentSlot: 0, partIndex: 0 },
        })),
      });
      await client.hello();
      expect(imported.contentDocIds.length).toBeGreaterThanOrEqual(3);
      if (mode === "bufferedAmount") client.socket.buffered = 524288;
      else client.socket.accepts = false;
      await client.subscribe(imported.contentDocIds);
      client.socket.buffered = 0;
      client.socket.accepts = true;
      for (let index = 0; index < 20; index++) {
        await client.host.tick();
        await client.drain();
      }
      expect(client.closes).toEqual([]);
      expect(imported.contentDocIds.every((id) => client.applied.has(id))).toBe(true);
      expect(client.host.diagnostics().outstandingBytes).toBe(0);
    } finally {
      await fixture.dispose();
    }
  });
}

for (const kib of [200, 216, 240, 256, 300, 1024]) {
  for (const char of ["x", "中文😀"]) {
    // 大输入与连续小增量必须同序无损，冷客户端通过目录、基线与 ACK 重建全部正文及下一轮。
    test(`B07/B11：${kib} KiB ${char} 冷刷新无损`, async () => {
      const text = char.repeat(Math.ceil((kib * 1024) / Buffer.byteLength(char)));
      const results: string[] = [];
      for (const small of [false, true]) {
        const fixture = await transferFixture();
        try {
          const writer = await fixture.connect();
          await writer.hello();
          await writeText(writer.host, text, small);
          const reader = await fixture.connect();
          const manifest = await reader.hello();
          const ids = await reader.discover(manifest.directoryDocId);
          for (const id of ids) await reader.receive([id]);
          await reader.receive([manifest.runtimeDocId, manifest.controlDocId]);
          results.push(liveText(ids.map((id) => reader.applied.get(id)!)));
          expect(results.at(-1)).toBe(`${text}后续轮次`);
          expect(reader.closes).toEqual([]);
          expect(reader.host.diagnostics().outstandingBytes).toBe(0);
        } finally {
          await fixture.dispose();
        }
      }
      expect(results[0]).toBe(results[1]);
    }, 30_000);
  }
}
