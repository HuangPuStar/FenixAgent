import { describe, expect, test } from "bun:test";
import { buildSandboxRebuildRequest, buildSandboxResourcePatch } from "../api/system-sandbox";

describe("system sandbox request helpers", () => {
  // 资源表单只应提交 CPU、内存、磁盘和 GPU 四项覆盖值，空值用于取消对应覆盖。
  test("builds a restricted resource patch", () => {
    expect(
      buildSandboxResourcePatch({
        cpu: "2",
        memoryMb: "4096",
        diskGb: "",
        gpuCount: "0",
      }),
    ).toEqual({ cpu: 2, memoryMb: 4096, diskGb: null, gpuCount: 0 });
  });

  // 重建范围必须生成后端可识别的互斥参数。
  test("builds pool, instance, and user rebuild requests", () => {
    expect(buildSandboxRebuildRequest({ poolId: "pool-1", scope: "pool" })).toEqual({ sandboxPoolId: "pool-1" });
    expect(buildSandboxRebuildRequest({ poolId: "pool-1", instanceId: "sbi-1", scope: "instance" })).toEqual({
      sandboxPoolId: "pool-1",
      instanceIds: ["sbi-1"],
    });
    expect(buildSandboxRebuildRequest({ poolId: "pool-1", userId: "user-1", scope: "user" })).toEqual({
      sandboxPoolId: "pool-1",
      userIds: ["user-1"],
    });
  });
});
