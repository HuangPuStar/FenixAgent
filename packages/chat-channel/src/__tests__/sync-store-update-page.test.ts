import { expect, test } from "bun:test";
import { firstUpdateAfter } from "../sync/store/memory-update-lookup";

// pageSize=1 不应反复读取旧前缀，每次定位成本随账本长度对数增长。
test("小页读取定位不重新遍历历史前缀", () => {
  let reads = 0;
  const updates = Array.from({ length: 2048 }, (_, index) => ({
    get updateSeq() {
      reads++;
      return index + 1;
    },
  }));
  for (let seq = 0; seq < 2048; seq++) expect(firstUpdateAfter(updates, seq)).toBe(seq);
  expect(reads).toBeLessThan(25000);
});

// 缺口必须留给读取层拒绝，二分定位不能假设序号就是数组索引。
test("有序缺口仍定位到第一条更大的序号", () => {
  const updates = [{ updateSeq: 1 }, { updateSeq: 4 }, { updateSeq: 5 }];
  expect(firstUpdateAfter(updates, 1)).toBe(1);
  expect(firstUpdateAfter(updates, 4)).toBe(2);
  expect(firstUpdateAfter(updates, 5)).toBe(3);
});
