import { expect, mock, test } from "bun:test";
import { startSchedulerUnlessDisabled } from "../bootstrap/scheduler-startup";

// 未显式禁用时必须保持生产默认行为并启动调度器。
test("starts the scheduler by default", async () => {
  const start = mock(async () => {});
  const onDisabled = mock(() => {});

  await startSchedulerUnlessDisabled({ disabled: false, start, onDisabled });

  expect(start).toHaveBeenCalledTimes(1);
  expect(onDisabled).not.toHaveBeenCalled();
});

// 显式禁用时不得读取、调度或更新任何持久化任务。
test("skips scheduler startup when explicitly disabled", async () => {
  const start = mock(async () => {});
  const onDisabled = mock(() => {});

  await startSchedulerUnlessDisabled({ disabled: true, start, onDisabled });

  expect(start).not.toHaveBeenCalled();
  expect(onDisabled).toHaveBeenCalledTimes(1);
});
