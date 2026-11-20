import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceObserver } from "../server";

const roots: string[] = [];
const watchers: ReturnType<typeof createWorkspaceObserver>[] = [];
afterEach(async () => {
  await Promise.all(watchers.splice(0).map((watcher) => watcher.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function until(predicate: () => boolean) {
  const end = Date.now() + 3000;
  while (!predicate() && Date.now() < end) await Bun.sleep(25);
  expect(predicate()).toBe(true);
}

// 只报告工作区内真实文件的后续变化，启动内容、符号链接和编辑器噪声不应误触发。
test("scoped observer ignores initial content symlinks and temporary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "editing-watch-"));
  roots.push(root);
  const outside = await mkdtemp(join(tmpdir(), "editing-outside-"));
  roots.push(outside);
  await writeFile(join(root, "existing.txt"), "before");
  await symlink(outside, join(root, "escape"));
  const changes: string[] = [];
  const observer = createWorkspaceObserver({
    root,
    onChange: (path, kind) => {
      changes.push(`${kind}:${path}`);
    },
  });
  watchers.push(observer);
  await observer.ready;
  expect(changes).toEqual([]);
  await writeFile(join(root, "existing.txt"), "after");
  await writeFile(join(root, "new.md"), "new");
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git", "index"), "ignore");
  await writeFile(join(root, ".draft.tmp"), "ignore");
  await writeFile(join(outside, "secret.txt"), "ignore");
  await until(() => changes.includes("change:existing.txt") && changes.includes("add:new.md"));
  expect(
    changes.some((change) => change.includes("secret") || change.includes(".git") || change.includes(".draft")),
  ).toBe(false);
  await observer.close();
  const count = changes.length;
  await writeFile(join(root, "later.txt"), "ignored after close");
  await Bun.sleep(100);
  expect(changes).toHaveLength(count);
});
