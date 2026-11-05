import { expect, test } from "bun:test";
import { resourceFits, sumResources } from "../services/resource-accounting";

// 十进制额度刚好用完时允许准入，不能因二进制误差拒绝。
test("decimal admission preserves exact capacity", () => {
  expect(
    resourceFits(
      { cpu: 0.3, memoryMb: 1, diskGb: 1, gpuCount: 0 },
      sumResources([
        { cpu: 0.1, memoryMb: 0.2, diskGb: 0.2, gpuCount: 0 },
        { cpu: 0.2, memoryMb: 0.2, diskGb: 0.2, gpuCount: 0 },
      ]),
    ),
  ).toBe(true);
});
