import { describe, expect, test } from "bun:test";

import { describeCron, PRESETS } from "../pages/agent-panel/components/CronEditor";

const translatePreset = (key: string) => `译文:${key}`;

describe("CronEditor describeCron Round 38 纯逻辑边界", () => {
  // 制表符和换行属于字段分隔空白，预设匹配前应一并忽略。
  test("以混合空白匹配预设", () => {
    expect(describeCron("\t0 * * * *\n", translatePreset)).toBe("译文:cron.presets.everyHour");
  });

  // 非预设分钟步长只读取步长文本，不校验其余字段组合。
  test("保留复合分钟步长文本", () => {
    expect(describeCron("*/5/2 8 1 1 1", translatePreset)).toBe("每 5/2 分钟");
  });

  // 空步长仍会进入分钟步长分支，函数不应抛出异常。
  test("描述空分钟步长", () => {
    expect(describeCron("*/ * * * *", translatePreset)).toBe("每  分钟");
  });

  // 每日分支使用 parseInt，因此小时中的小数部分会被截断。
  test("截断每日小数小时", () => {
    expect(describeCron("7 12.5 * * *", translatePreset)).toBe("每天中午 12:07");
  });

  // 每日分支同样接受以数字开头的小时字段。
  test("解析带后缀的每日小时", () => {
    expect(describeCron("4 7pm * * *", translatePreset)).toBe("每天上午 7:04");
  });

  // 超过十二的小时按照下午分支换算为十二小时制。
  test("换算二十四点为下午十二点", () => {
    expect(describeCron("0 24 * * *", translatePreset)).toBe("每天下午 12:00");
  });

  // 每日分支不验证分钟字段，非数字分钟会直接显示。
  test("保留每日非数字分钟", () => {
    expect(describeCron("ab 8 * * *", translatePreset)).toBe("每天上午 8:ab");
  });

  // 星期字段的单值按数组索引映射，越界索引会产生空日期名称。
  test("处理越界星期索引", () => {
    expect(describeCron("0 9 * * 7", translatePreset)).toBe("每周上午 9:00");
  });

  // 反向星期范围展开为空数组，但仍会返回每周描述。
  test("处理反向星期范围", () => {
    expect(describeCron("0 9 * * 5-3", translatePreset)).toBe("每周上午 9:00");
  });

  // 离散星期列表中的空项会按 Number(\"\") 映射为星期日。
  test("处理带尾逗号的星期列表", () => {
    expect(describeCron("0 9 * * 1,", translatePreset)).toBe("每周一、日上午 9:00");
  });

  // 范围中的越界终点会保留一个空名称，而不会拒绝整个表达式。
  test("处理越界星期范围终点", () => {
    expect(describeCron("0 9 * * 5-7", translatePreset)).toBe("每周五、六、上午 9:00");
  });

  // 每周分支保持输入中的分钟前导零，不额外改写已补零的文本。
  test("保留每周分钟前导零", () => {
    expect(describeCron("005 10 * * 2", translatePreset)).toBe("每周二上午 10:005");
  });

  // 每月分支会截断日期字段的小数部分。
  test("截断每月小数日期", () => {
    expect(describeCron("0 8 15.9 * *", translatePreset)).toBe("每月 15 号上午 8:00");
  });

  // 每月分支接受以数字开头的日期文本。
  test("解析带后缀的每月日期", () => {
    expect(describeCron("0 8 2nd * *", translatePreset)).toBe("每月 2 号上午 8:00");
  });

  // 指定月份分支会截断月份字段的小数部分。
  test("截断指定月份的小数", () => {
    expect(describeCron("0 8 2 3.7 *", translatePreset)).toBe("3月2号上午8:00");
  });

  // 指定月份分支也接受以数字开头的月份字段。
  test("解析带后缀的指定月份", () => {
    expect(describeCron("0 8 2 11th *", translatePreset)).toBe("11月2号上午8:00");
  });

  // 预设命中时调用方翻译函数的返回值应原样透传，即使它不是普通文案。
  test("透传预设翻译函数返回的空字符串", () => {
    expect(describeCron(PRESETS.daily9am, () => "")).toBe("");
  });

  // 非预设表达式不需要国际化函数参与格式化。
  test("非预设表达式不调用翻译函数", () => {
    let calls = 0;
    const translator = (_key: string) => {
      calls += 1;
      return "不应使用";
    };

    expect(describeCron("1 6 * * *", translator)).toBe("每天上午 6:01");
    expect(calls).toBe(0);
  });

  // 预设翻译函数抛出的错误会按调用方语义继续向上传播。
  test("传播预设翻译函数错误", () => {
    const translationError = new Error("翻译不可用");

    expect(() =>
      describeCron(PRESETS.monthly1st, () => {
        throw translationError;
      }),
    ).toThrow(translationError);
  });

  // 纯描述逻辑不会改写调用方传入的字符串对象值。
  test("不改写输入字符串", () => {
    const cron = "  2 14 * * 4  ";

    describeCron(cron, translatePreset);

    expect(cron).toBe("  2 14 * * 4  ");
  });
});
