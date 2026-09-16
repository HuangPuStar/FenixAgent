import { describe, expect, test } from "bun:test";
import { describeCron, PRESETS } from "../pages/agent-panel/components/CronEditor";

const translatePreset = (key: string) => `已翻译:${key}`;

describe("describeCron", () => {
  // 预设表达式应委托给调用方提供的国际化函数。
  test("识别每五分钟预设", () => {
    expect(describeCron(PRESETS.every5min, translatePreset)).toBe("已翻译:cron.presets.every5min");
  });

  // 预设匹配前需要忽略用户输入两侧的空白。
  test("识别带空白的每小时预设", () => {
    expect(describeCron(`  ${PRESETS.everyHour}  `, translatePreset)).toBe("已翻译:cron.presets.everyHour");
  });

  // 每日九点预设不应落入通用每日格式化分支。
  test("识别每日九点预设", () => {
    expect(describeCron(PRESETS.daily9am, translatePreset)).toBe("已翻译:cron.presets.daily9am");
  });

  // 工作日预设应保留专用的翻译 key。
  test("识别工作日九点预设", () => {
    expect(describeCron(PRESETS.weekday9am, translatePreset)).toBe("已翻译:cron.presets.weekday9am");
  });

  // 每月一日预设应优先使用预设翻译。
  test("识别每月一日预设", () => {
    expect(describeCron(PRESETS.monthly1st, translatePreset)).toBe("已翻译:cron.presets.monthly1st");
  });

  // 分钟步长表达式需抽取步长数字。
  test("描述十五分钟间隔", () => {
    expect(describeCron("*/15 * * * *", translatePreset)).toBe("每 15 分钟");
  });

  // 分钟步长分支按第一个字段处理其余合法字段。
  test("分钟步长保留零值", () => {
    expect(describeCron("*/0 * * * *", translatePreset)).toBe("每 0 分钟");
  });

  // 每日零点需转为十二小时制的上午十二点。
  test("描述每天零点", () => {
    expect(describeCron("0 0 * * *", translatePreset)).toBe("每天上午 12:00");
  });

  // 上午小时应保持原小时且补齐分钟。
  test("描述每天上午带分钟执行", () => {
    expect(describeCron("5 9 * * *", translatePreset)).toBe("每天上午 9:05");
  });

  // 分钟通配符不应输出伪造的分钟值。
  test("描述每天上午整点通配分钟", () => {
    expect(describeCron("* 9 * * *", translatePreset)).toBe("每天上午 9");
  });

  // 正午是独立于上午和下午的文案分支。
  test("描述每天正午", () => {
    expect(describeCron("30 12 * * *", translatePreset)).toBe("每天中午 12:30");
  });

  // 下午小时应换算为十二小时制。
  test("描述每天下午执行", () => {
    expect(describeCron("7 15 * * *", translatePreset)).toBe("每天下午 3:07");
  });

  // 单个星期值应映射为中文星期名称。
  test("描述每周单日执行", () => {
    expect(describeCron("0 8 * * 1", translatePreset)).toBe("每周一上午 8:00");
  });

  // 多个离散星期值应按输入顺序连接。
  test("描述每周多个离散日期", () => {
    expect(describeCron("5 13 * * 1,3,5", translatePreset)).toBe("每周一、三、五下午 1:05");
  });

  // 星期范围应展开区间内每一天。
  test("描述每周连续日期范围", () => {
    expect(describeCron("0 9 * * 2-4", translatePreset)).toBe("每周二、三、四上午 9:00");
  });

  // 星期分支应支持零点的十二小时制转换。
  test("描述每周日零点", () => {
    expect(describeCron("* 0 * * 0", translatePreset)).toBe("每周日上午 12");
  });

  // 每月表达式需要同时解析日期和小时。
  test("描述每月指定日期", () => {
    expect(describeCron("3 10 15 * *", translatePreset)).toBe("每月 15 号上午 10:03");
  });

  // 每月表达式中的正午应使用正午文案。
  test("描述每月正午执行", () => {
    expect(describeCron("0 12 1 * *", translatePreset)).toBe("每月 1 号中午 12:00");
  });

  // 每月表达式中的下午应换算为十二小时制。
  test("描述每月下午执行", () => {
    expect(describeCron("* 23 30 * *", translatePreset)).toBe("每月 30 号下午 11");
  });

  // 指定月份表达式应包含月份、日期和时刻。
  test("描述每年指定日期", () => {
    expect(describeCron("9 8 6 4 *", translatePreset)).toBe("4月6号上午8:09");
  });

  // 指定月份表达式中的零点需要保持十二小时制。
  test("描述每年零点执行", () => {
    expect(describeCron("0 0 1 1 *", translatePreset)).toBe("1月1号上午12:00");
  });

  // 指定月份表达式中的正午应使用独立文案。
  test("描述每年正午执行", () => {
    expect(describeCron("* 12 2 2 *", translatePreset)).toBe("2月2号中午12");
  });

  // 字段不足时无法构成标准 cron，应返回空结果。
  test("拒绝字段不足的表达式", () => {
    expect(describeCron("0 9 * *", translatePreset)).toBeNull();
  });

  // 字段过多时无法构成标准 cron，应返回空结果。
  test("拒绝字段过多的表达式", () => {
    expect(describeCron("0 9 * * * extra", translatePreset)).toBeNull();
  });

  // 空输入拆分后没有五个字段，应返回空结果。
  test("拒绝空表达式", () => {
    expect(describeCron("   ", translatePreset)).toBeNull();
  });

  // 非数字小时不能生成每日的人类可读描述。
  test("拒绝非数字的每日小时", () => {
    expect(describeCron("0 noon * * *", translatePreset)).toBeNull();
  });

  // 含非数字字符的星期字段不应进入星期格式化分支。
  test("拒绝非法星期字段", () => {
    expect(describeCron("0 9 * * mon", translatePreset)).toBeNull();
  });

  // 无法匹配任何已支持模式的合法五字段表达式应返回空结果。
  test("拒绝未支持的复杂表达式", () => {
    expect(describeCron("0 * 1 * 1", translatePreset)).toBeNull();
  });
});
