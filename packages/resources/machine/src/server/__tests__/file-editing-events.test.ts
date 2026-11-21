import { expect, test } from "bun:test";
import { FileChangedBatchEventSchema } from "../../schemas/file-events.schema";
import { flushPendingBatches, publishFileChanged } from "../services/file-event-limiter";
import { type FileEventFrame, subscribe } from "../services/file-event-queue";

// 突发批处理不能丢失重命名目标，否则新路径下的已打开编辑器无法收到刷新通知。
test("batched rename retains both source and destination paths", async () => {
  const environmentId = `editing-events-${crypto.randomUUID()}`;
  const frames: FileEventFrame[] = [];
  const release = subscribe(environmentId, (frame) => frames.push(frame));
  try {
    for (let index = 0; index < 21; index++)
      publishFileChanged(
        environmentId,
        { path: `old-${index}.md`, to: `new-${index}.md`, kind: "rename", source: "external" },
        undefined,
        1000,
      );
    flushPendingBatches(environmentId);
    await Bun.sleep(0);
    const batch = frames.find((frame) => frame.type === "file_changed_batch");
    expect(batch?.type).toBe("file_changed_batch");
    expect(FileChangedBatchEventSchema.parse(batch).changes[0]).toMatchObject({ path: "old-20.md", to: "new-20.md" });
  } finally {
    release();
  }
});
