// 垂直模型目录的检索行为（`web/lib/vertical-models.ts`）。
//
// 这一层是页面的数据流：关键字 → 可见条目集合。空态（无匹配 → 提示 + 清空出口）由页面渲染，本包当前
// 没有声明 DOM 测试依赖（`happy-dom` / `react-dom` 都不在 package.json 里，加依赖不属于本切片范围），
// 因此这里只钉住「什么算命中、什么算无匹配」这条规则；渲染层由类型检查与 i18n 键用例（
// `model-management-i18n.test.ts` 断言页面字面量键都在字典内）共同守护。

import { describe, expect, test } from "bun:test";
import { filterVerticalModels, type VerticalModelSearchFields } from "../lib/vertical-models";

function model(overrides: Partial<VerticalModelSearchFields> = {}): VerticalModelSearchFields {
  return {
    name: "风机物流运输合规性检测模型",
    description: "结合风机运输行业规范进行专有数据精调。",
    tags: ["物流合规", "多模态检测"],
    scenes: ["风电物流", "大件运输"],
    ...overrides,
  };
}

describe("filterVerticalModels", () => {
  // 空关键字必须返回全部条目（且是拷贝）：页面初始态与「清空搜索」都依赖这一点。
  test("空关键字不过滤并返回拷贝", () => {
    const source = [model(), model({ name: "人员PPE检测模型" })];

    const result = filterVerticalModels(source, "");

    expect(result).toHaveLength(2);
    expect(result).not.toBe(source);
  });

  // 名称命中：用户往往记住模型名里的行业词，检索必须覆盖名称。
  test("按名称命中", () => {
    const result = filterVerticalModels(
      [model(), model({ name: "电力抢修智能调度模型", tags: [], scenes: [] })],
      "抢修",
    );

    expect(result.map((item) => item.name)).toEqual(["电力抢修智能调度模型"]);
  });

  // 描述命中：模型名不含关键词但简介里提到时仍应可见，否则用户找不到目标模型。
  test("按描述命中", () => {
    const result = filterVerticalModels(
      [
        model({ description: "识别安全帽与反光衣的穿戴情况。" }),
        model({ name: "无关键词模型", description: "无关描述", tags: [], scenes: [] }),
      ],
      "反光衣",
    );

    expect(result).toHaveLength(1);
  });

  // 标签与场景命中：这两列是用户在筛选面板里最可能使用的检索词。
  test("按标签或场景命中", () => {
    const source = [model()];

    expect(filterVerticalModels(source, "物流合规")).toHaveLength(1);
    expect(filterVerticalModels(source, "大件运输")).toHaveLength(1);
  });

  // 四种字段都不含关键字时返回空集合：页面据此渲染空态，不能退化成「过滤全部」。
  test("无匹配时返回空集合", () => {
    expect(filterVerticalModels([model()], "不存在的关键字")).toEqual([]);
  });

  // 匹配大小写敏感（与迁移前一致）：明确固化现状，改动语义时这条会先红。
  test("匹配保持大小写敏感", () => {
    const source = [model({ name: "Qwen3-VL-2B" })];

    expect(filterVerticalModels(source, "qwen3")).toHaveLength(0);
    expect(filterVerticalModels(source, "Qwen3")).toHaveLength(1);
  });
});
