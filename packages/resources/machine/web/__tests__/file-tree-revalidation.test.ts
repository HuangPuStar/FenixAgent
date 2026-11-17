import { expect, spyOn, test } from "bun:test";
import { revalidateWorkspaceTree } from "../api/fs";

// 事件触发条件重取时不能丢掉大小，否则上传后会回退到未知或旧元数据。
test("条件重取保留零字节大小与修改时间", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        success: true,
        data: { paths: ["user/empty.txt"], mtimes: { "user/empty.txt": 1000 }, sizes: { "user/empty.txt": 0 } },
      }),
      { headers: { etag: '"tree-version"', "content-type": "application/json" } },
    ),
  );
  try {
    expect(await revalidateWorkspaceTree("env-1")).toEqual({
      status: "updated",
      etag: '"tree-version"',
      tree: { paths: ["user/empty.txt"], mtimes: { "user/empty.txt": 1000 }, sizes: { "user/empty.txt": 0 } },
    });
  } finally {
    fetch.mockRestore();
  }
});

// 旧机器端缺少字段时必须保持未知，304 必须保留调用方现有快照。
test("兼容缺失大小的树快照与 304 条件响应", async () => {
  const fetch = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: { paths: ["old.txt"] },
        }),
      ),
    )
    .mockResolvedValueOnce(new Response(null, { status: 304 }));
  try {
    const result = await revalidateWorkspaceTree("env-1");
    expect(result.status).toBe("updated");
    if (result.status === "updated") expect(result.tree.sizes).toBeUndefined();
    expect(await revalidateWorkspaceTree("env-1", '"tree-version"')).toEqual({ status: "not-modified" });
  } finally {
    fetch.mockRestore();
  }
});
