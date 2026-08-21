import { describe, expect, test } from "bun:test";
import { groupByRecency } from "../../components/chat/session-grouping";

const labels = { today: "今天", yesterday: "昨天", earlier: "更早" };

type Session = { id: string; updatedAt?: string | null; metadata?: { source: string } };

function localDay(offset: number, hour = 12, minute = 0, second = 0, millisecond = 0): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour, minute, second, millisecond);
}

function session(id: string, updatedAt?: string | null): Session {
  return { id, updatedAt };
}

function ids(groups: ReturnType<typeof groupByRecency<Session>>): string[][] {
  return groups.map((group) => group.sessions.map((item) => item.id));
}

describe("groupByRecency 纯逻辑边界", () => {
  // 空会话列表不应制造空分组，避免侧栏渲染无意义标题。
  test("空列表返回空分组", () => {
    expect(groupByRecency([], labels)).toEqual([]);
  });

  // 当天中午更新的会话应进入今天分组。
  test("当天会话归入今天", () => {
    expect(ids(groupByRecency([session("today", localDay(0).toISOString())], labels))).toEqual([["today"]]);
  });

  // 昨天中午更新的会话应进入昨天分组。
  test("昨天会话归入昨天", () => {
    expect(ids(groupByRecency([session("yesterday", localDay(-1).toISOString())], labels))).toEqual([["yesterday"]]);
  });

  // 两天前的会话应进入更早分组。
  test("两天前会话归入更早", () => {
    expect(ids(groupByRecency([session("earlier", localDay(-2).toISOString())], labels))).toEqual([["earlier"]]);
  });

  // 今天零点是今天分组的包含边界。
  test("今天零点归入今天", () => {
    expect(ids(groupByRecency([session("start", localDay(0, 0).toISOString())], labels))).toEqual([["start"]]);
  });

  // 昨天零点是昨天分组的包含边界。
  test("昨天零点归入昨天", () => {
    expect(ids(groupByRecency([session("start", localDay(-1, 0).toISOString())], labels))).toEqual([["start"]]);
  });

  // 昨天开始前一毫秒必须落入更早分组。
  test("昨天零点前一毫秒归入更早", () => {
    expect(ids(groupByRecency([session("before", localDay(-1, 0, 0, 0, -1).toISOString())], labels))).toEqual([
      ["before"],
    ]);
  });

  // 未来时间仍满足今天及以后条件，应保留在今天分组。
  test("未来会话归入今天", () => {
    expect(ids(groupByRecency([session("future", localDay(3).toISOString())], labels))).toEqual([["future"]]);
  });

  // 缺失更新时间按 epoch 处理，归入更早分组。
  test("缺失更新时间归入更早", () => {
    expect(ids(groupByRecency([session("missing")], labels))).toEqual([["missing"]]);
  });

  // null 更新时间与缺失值具有相同的最早语义。
  test("null 更新时间归入更早", () => {
    expect(ids(groupByRecency([session("null", null)], labels))).toEqual([["null"]]);
  });

  // 空字符串不是有效更新时间，应安全落入更早分组。
  test("空更新时间归入更早", () => {
    expect(ids(groupByRecency([session("empty", "")], labels))).toEqual([["empty"]]);
  });

  // 非法日期不能被误判为今天或昨天。
  test("非法日期归入更早", () => {
    expect(ids(groupByRecency([session("invalid", "not-a-date")], labels))).toEqual([["invalid"]]);
  });

  // 今天、昨天和更早均存在时必须保持三个展示分组的固定顺序。
  test("三个非空分组按今天昨天更早排序", () => {
    expect(
      groupByRecency(
        [
          session("old", localDay(-2).toISOString()),
          session("today", localDay(0).toISOString()),
          session("yesterday", localDay(-1).toISOString()),
        ],
        labels,
      ).map((group) => group.label),
    ).toEqual(["今天", "昨天", "更早"]);
  });

  // 缺少中间分组时不应留下空标题。
  test("跳过空的昨天分组", () => {
    expect(
      groupByRecency(
        [session("today", localDay(0).toISOString()), session("old", localDay(-2).toISOString())],
        labels,
      ).map((group) => group.label),
    ).toEqual(["今天", "更早"]);
  });

  // 自定义标签必须原样用于输出，不应被逻辑层写死。
  test("使用调用方传入的标签", () => {
    expect(
      groupByRecency([session("today", localDay(0).toISOString())], { today: "T", yesterday: "Y", earlier: "E" })[0]
        ?.label,
    ).toBe("T");
  });

  // 同一分组内应以较新的更新时间优先。
  test("今天分组按更新时间降序", () => {
    expect(
      ids(
        groupByRecency(
          [session("older", localDay(0, 9).toISOString()), session("newer", localDay(0, 18).toISOString())],
          labels,
        ),
      ),
    ).toEqual([["newer", "older"]]);
  });

  // 昨天分组内也必须以较新的时间优先。
  test("昨天分组按更新时间降序", () => {
    expect(
      ids(
        groupByRecency(
          [session("older", localDay(-1, 9).toISOString()), session("newer", localDay(-1, 18).toISOString())],
          labels,
        ),
      ),
    ).toEqual([["newer", "older"]]);
  });

  // 更早分组内也必须以较新的时间优先。
  test("更早分组按更新时间降序", () => {
    expect(
      ids(
        groupByRecency(
          [session("older", localDay(-8).toISOString()), session("newer", localDay(-3).toISOString())],
          labels,
        ),
      ),
    ).toEqual([["newer", "older"]]);
  });

  // 跨分组输入乱序时，分组顺序不依赖输入排列。
  test("乱序输入仍按分组新旧输出", () => {
    expect(
      ids(
        groupByRecency(
          [
            session("old", localDay(-4).toISOString()),
            session("yesterday", localDay(-1).toISOString()),
            session("today", localDay(0).toISOString()),
          ],
          labels,
        ),
      ),
    ).toEqual([["today"], ["yesterday"], ["old"]]);
  });

  // 相同时间戳依赖稳定排序保持原始先后，避免列表无故跳动。
  test("相同时间戳保持输入顺序", () => {
    const timestamp = localDay(0).toISOString();
    expect(ids(groupByRecency([session("first", timestamp), session("second", timestamp)], labels))).toEqual([
      ["first", "second"],
    ]);
  });

  // 缺失时间的多个会话仍按稳定排序保持调用方顺序。
  test("多个缺失时间保持输入顺序", () => {
    expect(ids(groupByRecency([session("first"), session("second", null), session("third", "")], labels))).toEqual([
      ["first", "second", "third"],
    ]);
  });

  // 有效的更早日期应排在 epoch 缺失值之前。
  test("有效更早日期优先于缺失时间", () => {
    expect(ids(groupByRecency([session("missing"), session("dated", localDay(-30).toISOString())], labels))).toEqual([
      ["dated", "missing"],
    ]);
  });

  // 输入数组必须保持原始引用顺序，排序只能作用于内部副本。
  test("排序不修改输入数组", () => {
    const sessions = [session("old", localDay(-3).toISOString()), session("today", localDay(0).toISOString())];
    groupByRecency(sessions, labels);
    expect(sessions.map((item) => item.id)).toEqual(["old", "today"]);
  });

  // 输出应复用会话对象，而不是深拷贝丢失扩展字段。
  test("输出保留原会话对象引用", () => {
    const original: Session = { id: "rich", updatedAt: localDay(0).toISOString(), metadata: { source: "relay" } };
    expect(groupByRecency([original], labels)[0]?.sessions[0]).toBe(original);
  });

  // 函数应支持附带业务字段的泛型会话条目。
  test("泛型会话字段不丢失", () => {
    const item = { id: "rich", updatedAt: localDay(0).toISOString(), unreadCount: 3 };
    expect(groupByRecency([item], labels)[0]?.sessions[0]?.unreadCount).toBe(3);
  });

  // 仅今天数据时不应附带昨天或更早的空数组。
  test("仅今天数据只输出一个分组", () => {
    expect(
      groupByRecency([session("a", localDay(0).toISOString()), session("b", localDay(0, 1).toISOString())], labels),
    ).toHaveLength(1);
  });

  // 仅昨天数据时昨天仍应成为第一个且唯一的输出分组。
  test("仅昨天数据只输出昨天分组", () => {
    const groups = groupByRecency([session("a", localDay(-1).toISOString())], labels);
    expect(groups).toEqual([{ label: "昨天", sessions: [groups[0]?.sessions[0]] }]);
  });

  // 仅更早数据时更早仍应成为第一个且唯一的输出分组。
  test("仅更早数据只输出更早分组", () => {
    expect(groupByRecency([session("a", localDay(-10).toISOString())], labels).map((group) => group.label)).toEqual([
      "更早",
    ]);
  });

  // ISO 带时区偏移的时间必须按解析后的本地日期归类。
  test("带时区偏移的当天时间归入今天", () => {
    const date = localDay(0, 12);
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const absolute = Math.abs(offsetMinutes);
    const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T12:00:00${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
    expect(ids(groupByRecency([session("offset", value)], labels))).toEqual([["offset"]]);
  });

  // 当天最后一毫秒仍属于今天而不是未来或更早分组。
  test("当天结束前一毫秒归入今天", () => {
    expect(ids(groupByRecency([session("end", localDay(1, 0, 0, 0, -1).toISOString())], labels))).toEqual([["end"]]);
  });

  // 昨天最后一毫秒仍属于昨天。
  test("昨天结束前一毫秒归入昨天", () => {
    expect(ids(groupByRecency([session("end", localDay(0, 0, 0, 0, -1).toISOString())], labels))).toEqual([["end"]]);
  });

  // 跨月较早日期不应影响分组判断。
  test("跨月较早日期归入更早", () => {
    expect(ids(groupByRecency([session("cross-month", localDay(-40).toISOString())], labels))).toEqual([
      ["cross-month"],
    ]);
  });

  // 跨年较早日期不应影响分组判断。
  test("跨年较早日期归入更早", () => {
    expect(ids(groupByRecency([session("cross-year", localDay(-400).toISOString())], labels))).toEqual([
      ["cross-year"],
    ]);
  });

  // 今天与未来会话同组时，未来的较大时间戳排在前面。
  test("未来会话在今天分组内按时间排序", () => {
    expect(
      ids(
        groupByRecency(
          [session("today", localDay(0, 12).toISOString()), session("future", localDay(1, 12).toISOString())],
          labels,
        ),
      ),
    ).toEqual([["future", "today"]]);
  });

  // 不同日期的今天会话必须都保留，不能因为分组键相同而去重。
  test("今天分组保留重复标识会话", () => {
    expect(
      ids(
        groupByRecency(
          [session("same", localDay(0, 8).toISOString()), session("same", localDay(0, 16).toISOString())],
          labels,
        ),
      ),
    ).toEqual([["same", "same"]]);
  });

  // 不同分组的同标识会话不能互相覆盖。
  test("跨分组保留同标识会话", () => {
    expect(
      ids(
        groupByRecency(
          [session("same", localDay(-2).toISOString()), session("same", localDay(0).toISOString())],
          labels,
        ),
      ),
    ).toEqual([["same"], ["same"]]);
  });

  // 标签对象仅被读取，不应被函数修改。
  test("不修改标签对象", () => {
    const customLabels = { today: "T", yesterday: "Y", earlier: "E" };
    groupByRecency([session("today", localDay(0).toISOString())], customLabels);
    expect(customLabels).toEqual({ today: "T", yesterday: "Y", earlier: "E" });
  });

  // 原会话对象的嵌套元数据不能在分组时被改写。
  test("不修改会话嵌套数据", () => {
    const original: Session = { id: "nested", updatedAt: localDay(0).toISOString(), metadata: { source: "agent" } };
    groupByRecency([original], labels);
    expect(original.metadata).toEqual({ source: "agent" });
  });

  // 只含无效时间和有效昨天时，昨天应先于无效值输出。
  test("有效昨天时间优先于无效时间", () => {
    expect(
      ids(groupByRecency([session("invalid", "invalid"), session("yesterday", localDay(-1).toISOString())], labels)),
    ).toEqual([["yesterday"], ["invalid"]]);
  });

  // 无效时间与 epoch 缺失值都归更早且稳定保留输入次序。
  test("无效时间与缺失时间保持稳定顺序", () => {
    expect(ids(groupByRecency([session("invalid", "invalid"), session("missing")], labels))).toEqual([
      ["invalid", "missing"],
    ]);
  });

  // readonly 输入数组可直接传入，函数不应要求调用方复制。
  test("接受只读会话数组", () => {
    const sessions = [session("today", localDay(0).toISOString())] as const;
    expect(ids(groupByRecency(sessions, labels))).toEqual([["today"]]);
  });

  // 冻结输入数组也应可用，证明内部排序不尝试写入调用方数组。
  test("接受冻结的输入数组", () => {
    const sessions = Object.freeze([
      session("old", localDay(-2).toISOString()),
      session("today", localDay(0).toISOString()),
    ]);
    expect(ids(groupByRecency(sessions, labels))).toEqual([["today"], ["old"]]);
  });

  // 多个更早会话与一个今天会话混合时，各分组内部排序独立。
  test("分组内部排序彼此独立", () => {
    expect(
      ids(
        groupByRecency(
          [
            session("oldest", localDay(-20).toISOString()),
            session("today", localDay(0).toISOString()),
            session("newer-old", localDay(-3).toISOString()),
          ],
          labels,
        ),
      ),
    ).toEqual([["today"], ["newer-old", "oldest"]]);
  });

  // 今天、昨天、更早的原始会话数量必须在输出中完整守恒。
  test("分组不丢失任何会话", () => {
    const input = [
      session("t1", localDay(0).toISOString()),
      session("y1", localDay(-1).toISOString()),
      session("e1", localDay(-2).toISOString()),
      session("e2"),
    ];
    expect(groupByRecency(input, labels).flatMap((group) => group.sessions)).toHaveLength(input.length);
  });

  // 同一调用中输出会话顺序由时间决定，不受原始分组顺序干扰。
  test("输出顺序不依赖原始分组顺序", () => {
    const input = [
      session("yesterday", localDay(-1, 20).toISOString()),
      session("today", localDay(0, 1).toISOString()),
      session("old", localDay(-3, 20).toISOString()),
    ];
    expect(groupByRecency(input, labels).flatMap((group) => group.sessions.map((item) => item.id))).toEqual([
      "today",
      "yesterday",
      "old",
    ]);
  });
});
