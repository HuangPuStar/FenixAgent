import { test } from "bun:test";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

// 两个编辑器使用独立草稿，页面首次加载时不能因为重置计数相同而产生重复 key。
test("模型页的服务商与模型弹窗具有独立组件身份", async () => {
  await execute(process.execPath, [join(import.meta.dir, "fixtures", "model-dialog-keys.fixture.tsx")], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
});
