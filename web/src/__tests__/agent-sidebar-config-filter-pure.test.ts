import { describe, expect, test } from "bun:test";

import { FileText } from "lucide-react";

import { filterNavGroups, type NavEntry } from "../pages/agent-panel/AgentSidebarConfig";

type TestGroup = {
  id: string;
  label: string;
  items: NavEntry[];
  metadata?: { source: string };
};

const icons = {
  alpha: FileText,
  beta: FileText,
  gamma: FileText,
  delta: FileText,
};

function entry(id: string): NavEntry {
  return { id, labelKey: `label.${id}`, icon: icons[id as keyof typeof icons] ?? icons.alpha };
}

function groups(): TestGroup[] {
  return [
    {
      id: "first",
      label: "第一组",
      items: [entry("alpha"), entry("beta")],
      metadata: { source: "built-in" },
    },
    {
      id: "second",
      label: "第二组",
      items: [entry("gamma"), entry("delta")],
    },
  ];
}

function itemIds(value: TestGroup[]): string[][] {
  return value.map((group) => group.items.map((item) => item.id));
}

describe("filterNavGroups 纯逻辑", () => {
  // 未隐藏任何标签时应保留所有分组、项目及原有顺序。
  test("空隐藏列表保留全部导航项目", () => {
    const source = groups();

    expect(itemIds(filterNavGroups(source, []))).toEqual([
      ["alpha", "beta"],
      ["gamma", "delta"],
    ]);
  });

  // 隐藏第一组首项时只移除匹配项目。
  test("隐藏第一组首项", () => {
    expect(itemIds(filterNavGroups(groups(), ["alpha"]))).toEqual([["beta"], ["gamma", "delta"]]);
  });

  // 隐藏第一组末项时应保留前项。
  test("隐藏第一组末项", () => {
    expect(itemIds(filterNavGroups(groups(), ["beta"]))).toEqual([["alpha"], ["gamma", "delta"]]);
  });

  // 隐藏第二组首项时不影响其他分组。
  test("隐藏第二组首项", () => {
    expect(itemIds(filterNavGroups(groups(), ["gamma"]))).toEqual([["alpha", "beta"], ["delta"]]);
  });

  // 隐藏第二组末项时不影响其他分组。
  test("隐藏第二组末项", () => {
    expect(itemIds(filterNavGroups(groups(), ["delta"]))).toEqual([["alpha", "beta"], ["gamma"]]);
  });

  // 一次隐藏多个分组中的项目应各自生效。
  test("同时隐藏跨组项目", () => {
    expect(itemIds(filterNavGroups(groups(), ["alpha", "delta"]))).toEqual([["beta"], ["gamma"]]);
  });

  // 完整隐藏一个分组后应移除空分组。
  test("隐藏第一组全部项目会移除第一组", () => {
    expect(filterNavGroups(groups(), ["alpha", "beta"]).map((group) => group.id)).toEqual(["second"]);
  });

  // 完整隐藏末尾分组后应移除空分组。
  test("隐藏第二组全部项目会移除第二组", () => {
    expect(filterNavGroups(groups(), ["gamma", "delta"]).map((group) => group.id)).toEqual(["first"]);
  });

  // 全部项目隐藏后不应留下空壳分组。
  test("隐藏全部项目返回空数组", () => {
    expect(filterNavGroups(groups(), ["alpha", "beta", "gamma", "delta"])).toEqual([]);
  });

  // 未知隐藏 ID 不应误删合法项目。
  test("未知隐藏项目不影响结果", () => {
    expect(itemIds(filterNavGroups(groups(), ["missing"]))).toEqual([
      ["alpha", "beta"],
      ["gamma", "delta"],
    ]);
  });

  // 重复隐藏 ID 应与单次隐藏有相同结果。
  test("重复隐藏项目保持幂等", () => {
    expect(itemIds(filterNavGroups(groups(), ["alpha", "alpha"]))).toEqual([["beta"], ["gamma", "delta"]]);
  });

  // 隐藏列表顺序不应改变过滤语义。
  test("隐藏列表顺序不影响结果", () => {
    expect(filterNavGroups(groups(), ["delta", "alpha"])).toEqual(filterNavGroups(groups(), ["alpha", "delta"]));
  });

  // 项目顺序是导航显示顺序，过滤后必须稳定。
  test("保留项目的相对顺序", () => {
    const source = [{ id: "only", label: "唯一", items: [entry("alpha"), entry("beta"), entry("gamma")] }];

    expect(itemIds(filterNavGroups(source, ["beta"]))).toEqual([["alpha", "gamma"]]);
  });

  // 分组顺序也是展示契约，过滤不能重排。
  test("保留分组的相对顺序", () => {
    const source = [
      { id: "third", label: "第三组", items: [entry("alpha")] },
      { id: "first", label: "第一组", items: [entry("beta")] },
      { id: "second", label: "第二组", items: [entry("gamma")] },
    ];

    expect(filterNavGroups(source, []).map((group) => group.id)).toEqual(["third", "first", "second"]);
  });

  // 空输入本身是合法边界，应稳定返回空数组。
  test("空分组输入返回空数组", () => {
    expect(filterNavGroups<TestGroup>([], [])).toEqual([]);
  });

  // 原本为空的分组不应出现在输出中。
  test("输入中的空分组会被移除", () => {
    const source = [{ id: "empty", label: "空组", items: [] as NavEntry[] }];

    expect(filterNavGroups(source, [])).toEqual([]);
  });

  // 空组不能阻止其他非空分组显示。
  test("空分组不会影响非空分组", () => {
    const source = [{ id: "empty", label: "空组", items: [] as NavEntry[] }, ...groups()];

    expect(filterNavGroups(source, []).map((group) => group.id)).toEqual(["first", "second"]);
  });

  // 自定义分组字段应随浅拷贝保留。
  test("保留分组扩展字段", () => {
    expect(filterNavGroups(groups(), ["alpha"])[0].metadata).toEqual({ source: "built-in" });
  });

  // 过滤实现不应改写调用方传入的分组数组。
  test("不修改输入分组数组", () => {
    const source = groups();
    const firstGroup = source[0];
    const secondGroup = source[1];

    filterNavGroups(source, ["alpha"]);

    expect(source[0]).toBe(firstGroup);
    expect(source[1]).toBe(secondGroup);
  });

  // 过滤实现不应改写调用方传入的项目数组。
  test("不修改输入项目数组", () => {
    const source = groups();
    const firstItems = source[0].items;

    filterNavGroups(source, ["alpha"]);

    expect(source[0].items).toBe(firstItems);
    expect(source[0].items.map((item) => item.id)).toEqual(["alpha", "beta"]);
  });

  // 返回分组需要是新对象，避免调用方修改结果污染配置。
  test("返回新的分组对象", () => {
    const source = groups();

    expect(filterNavGroups(source, [])[0]).not.toBe(source[0]);
  });

  // 返回项目数组需要独立于输入数组。
  test("返回新的项目数组", () => {
    const source = groups();

    expect(filterNavGroups(source, [])[0].items).not.toBe(source[0].items);
  });

  // 项目对象自身无需克隆，应保持图标等引用稳定。
  test("保留项目对象引用", () => {
    const source = groups();

    expect(filterNavGroups(source, [])[0].items[0]).toBe(source[0].items[0]);
  });

  // 修改结果项目数组不能反向修改输入。
  test("修改结果项目数组不影响输入", () => {
    const source = groups();
    const result = filterNavGroups(source, []);
    result[0].items.pop();

    expect(source[0].items.map((item) => item.id)).toEqual(["alpha", "beta"]);
  });

  // 修改结果分组数组不能反向修改输入。
  test("修改结果分组数组不影响输入", () => {
    const source = groups();
    const result = filterNavGroups(source, []);
    result.pop();

    expect(source).toHaveLength(2);
  });

  // 同一个 ID 在不同分组出现时都属于隐藏范围。
  test("重复项目 ID 会在全部分组中隐藏", () => {
    const source = [
      { id: "one", label: "一", items: [entry("alpha"), entry("beta")] },
      { id: "two", label: "二", items: [entry("alpha"), entry("gamma")] },
    ];

    expect(itemIds(filterNavGroups(source, ["alpha"]))).toEqual([["beta"], ["gamma"]]);
  });

  // 仅保留单项的分组仍是有效导航组。
  test("单个未隐藏项目保留分组", () => {
    const source = [{ id: "single", label: "单项", items: [entry("alpha")] }];

    expect(filterNavGroups(source, [])).toHaveLength(1);
  });

  // 隐藏单项分组的唯一项目应移除该组。
  test("隐藏单项分组的唯一项目移除分组", () => {
    const source = [{ id: "single", label: "单项", items: [entry("alpha")] }];

    expect(filterNavGroups(source, ["alpha"])).toEqual([]);
  });

  // 空字符串隐藏 ID 不能匹配正常项目。
  test("空字符串隐藏 ID 不影响正常项目", () => {
    expect(itemIds(filterNavGroups(groups(), [""]))).toEqual([
      ["alpha", "beta"],
      ["gamma", "delta"],
    ]);
  });

  // 大小写不同的 ID 应视为不同项目。
  test("隐藏 ID 区分大小写", () => {
    expect(itemIds(filterNavGroups(groups(), ["ALPHA"]))).toEqual([
      ["alpha", "beta"],
      ["gamma", "delta"],
    ]);
  });

  // ID 中的空格不应被隐式裁剪，以免错误隐藏项目。
  test("隐藏 ID 不会隐式裁剪空格", () => {
    expect(itemIds(filterNavGroups(groups(), [" alpha "]))).toEqual([
      ["alpha", "beta"],
      ["gamma", "delta"],
    ]);
  });

  // 分组 label 不参与隐藏匹配。
  test("分组标签不参与隐藏匹配", () => {
    const source = [{ id: "alpha", label: "alpha", items: [entry("beta")] }];

    expect(itemIds(filterNavGroups(source, ["alpha"]))).toEqual([["beta"]]);
  });

  // 分组 ID 不参与隐藏匹配。
  test("分组 ID 不参与隐藏匹配", () => {
    const source = [{ id: "alpha", label: "分组", items: [entry("beta")] }];

    expect(itemIds(filterNavGroups(source, ["alpha"]))).toEqual([["beta"]]);
  });

  // item 的 labelKey 与 id 无关，匹配必须只依据 id。
  test("项目 labelKey 不参与隐藏匹配", () => {
    const source = [{ id: "one", label: "一", items: [{ ...entry("alpha"), labelKey: "beta" }] }];

    expect(itemIds(filterNavGroups(source, ["beta"]))).toEqual([["alpha"]]);
  });

  // 保留项目的 icon 引用不能被过滤过程替换。
  test("保留项目图标引用", () => {
    const source = groups();

    expect(filterNavGroups(source, ["beta"])[0].items[0].icon).toBe(source[0].items[0].icon);
  });

  // 多余隐藏 ID 与有效隐藏 ID 可以混用。
  test("未知与有效隐藏 ID 可混用", () => {
    expect(itemIds(filterNavGroups(groups(), ["missing", "beta", "other"]))).toEqual([["alpha"], ["gamma", "delta"]]);
  });

  // 完全相同的过滤操作应产生同值结果。
  test("相同输入产生确定结果", () => {
    const source = groups();

    expect(filterNavGroups(source, ["alpha", "gamma"])).toEqual(filterNavGroups(source, ["alpha", "gamma"]));
  });

  // 每次调用都应隔离返回容器，避免调用间共享可变数组。
  test("重复调用不共享返回数组", () => {
    const source = groups();

    expect(filterNavGroups(source, [])).not.toBe(filterNavGroups(source, []));
  });

  // 每次调用都应隔离分组对象。
  test("重复调用不共享返回分组对象", () => {
    const source = groups();

    expect(filterNavGroups(source, [])[0]).not.toBe(filterNavGroups(source, [])[0]);
  });

  // 每次调用都应隔离项目数组。
  test("重复调用不共享返回项目数组", () => {
    const source = groups();

    expect(filterNavGroups(source, [])[0].items).not.toBe(filterNavGroups(source, [])[0].items);
  });

  // 过滤第一项后剩余项应仍保有原 labelKey。
  test("保留项目的 labelKey", () => {
    const result = filterNavGroups(groups(), ["alpha"]);

    expect(result[0].items[0].labelKey).toBe("label.beta");
  });

  // 连续分组都清空时不应留下中间空组。
  test("多个清空分组全部移除", () => {
    const source = [
      { id: "one", label: "一", items: [entry("alpha")] },
      { id: "two", label: "二", items: [entry("beta")] },
      { id: "three", label: "三", items: [entry("gamma")] },
    ];

    expect(filterNavGroups(source, ["alpha", "beta"]).map((group) => group.id)).toEqual(["three"]);
  });

  // 空组夹在有效组之间时，输出顺序应跳过它而不重排有效组。
  test("中间空组被移除但保留其他顺序", () => {
    const source = [
      { id: "one", label: "一", items: [entry("alpha")] },
      { id: "empty", label: "空", items: [] as NavEntry[] },
      { id: "two", label: "二", items: [entry("beta")] },
    ];

    expect(filterNavGroups(source, []).map((group) => group.id)).toEqual(["one", "two"]);
  });

  // 一组中多个重复 ID 被隐藏时不应保留漏网项目。
  test("同组重复项目 ID 全部隐藏", () => {
    const source = [{ id: "one", label: "一", items: [entry("alpha"), entry("alpha")] }];

    expect(filterNavGroups(source, ["alpha"])).toEqual([]);
  });

  // 不隐藏重复项目时应完整保留项目数量。
  test("不隐藏时保留重复项目", () => {
    const source = [{ id: "one", label: "一", items: [entry("alpha"), entry("alpha")] }];

    expect(filterNavGroups(source, [])).toHaveLength(1);
    expect(filterNavGroups(source, [])[0].items).toHaveLength(2);
  });

  // 只隐藏部分重复分组中的其他项目，重复项目应保留。
  test("隐藏其他项目不影响重复项目", () => {
    const source = [{ id: "one", label: "一", items: [entry("alpha"), entry("alpha"), entry("beta")] }];

    expect(itemIds(filterNavGroups(source, ["beta"]))).toEqual([["alpha", "alpha"]]);
  });

  // 扩展字段的对象引用应保持不变，函数不应深拷贝无关数据。
  test("保留扩展字段对象引用", () => {
    const source = groups();
    const metadata = source[0].metadata;

    expect(filterNavGroups(source, [])[0].metadata).toBe(metadata);
  });

  // 过滤不应写入隐藏列表。
  test("不修改隐藏列表", () => {
    const hidden = ["alpha", "beta"];

    filterNavGroups(groups(), hidden);

    expect(hidden).toEqual(["alpha", "beta"]);
  });

  // 冻结输入也应可被安全读取，证明未进行原地修改。
  test("可处理冻结的输入数据", () => {
    const source = Object.freeze(
      groups().map((group) =>
        Object.freeze({ ...group, items: Object.freeze(group.items.slice()) as unknown as NavEntry[] }),
      ),
    ) as unknown as TestGroup[];

    expect(itemIds(filterNavGroups(source, ["alpha"]))).toEqual([["beta"], ["gamma", "delta"]]);
  });

  // 未命中隐藏项时仍应复制所有分组，保证结果可独立使用。
  test("未命中隐藏项仍返回独立分组", () => {
    const source = groups();
    const result = filterNavGroups(source, ["missing"]);

    expect(result[0]).not.toBe(source[0]);
    expect(result[1]).not.toBe(source[1]);
  });

  // 命中隐藏项时剩余分组的扩展字段与项目引用必须完整保留。
  test("过滤后保留剩余分组数据", () => {
    const source = groups();
    const result = filterNavGroups(source, ["beta", "gamma"]);

    expect(result[0].metadata).toEqual({ source: "built-in" });
    expect(result[1].items[0]).toBe(source[1].items[1]);
  });

  // 所有项目被隐藏时，输入内容仍应保持原样。
  test("全量过滤不修改输入内容", () => {
    const source = groups();

    filterNavGroups(source, ["alpha", "beta", "gamma", "delta"]);

    expect(itemIds(source)).toEqual([
      ["alpha", "beta"],
      ["gamma", "delta"],
    ]);
  });

  // 仅隐藏第二组时第一组的项目数组也应独立复制。
  test("未过滤分组的项目数组同样独立", () => {
    const source = groups();
    const result = filterNavGroups(source, ["gamma"]);

    expect(result[0].items).not.toBe(source[0].items);
  });

  // 两组都剩一个项目时应维持两个有效分组。
  test("每组剩一个项目时均保留", () => {
    expect(filterNavGroups(groups(), ["alpha", "gamma"]).map((group) => group.id)).toEqual(["first", "second"]);
  });

  // 复杂隐藏集合应只留下未命中的项目。
  test("复杂隐藏集合仅保留未命中项目", () => {
    expect(itemIds(filterNavGroups(groups(), ["alpha", "gamma", "unknown", "alpha"]))).toEqual([["beta"], ["delta"]]);
  });
});
