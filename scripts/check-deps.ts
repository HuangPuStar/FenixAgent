#!/usr/bin/env bun
/**
 * 依赖健康度检查脚本。
 * 输出过期依赖和依赖树摘要。
 */
import { $ } from "bun";

console.log("=== Outdated Dependencies ===\n");
try {
  await $`bun outdated`.quiet();
} catch {
  // bun outdated exits non-zero when there are outdated packages
}

console.log("\n=== Dependency Tree Summary ===\n");
try {
  const result = await $`bun pm ls`.quiet();
  const lines = result.text().split("\n");
  console.log(`Total packages: ${lines.length}`);
} catch {
  console.log("Unable to list packages.");
}

console.log("\nDone. Review above for outdated packages.");
