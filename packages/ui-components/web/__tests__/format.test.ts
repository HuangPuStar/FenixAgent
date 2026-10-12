import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatClockTime,
  formatCost,
  formatDate,
  formatDateTime,
  formatDurationMs,
  formatInterval,
  formatSeconds,
  formatTokens,
  truncate,
} from "@fenix/ui-components/lib/format";

/**
 * 格式化原语的契约测试。
 *
 * 断言一律显式给 `locale` 与 `timeZone`（`"UTC"`），因此**不随运行环境漂移**：换台时区不同的机器、
 * 或 CI 容器里 `TZ` 为空，结果都一致。唯一的例外是「默认区域」那条，它两侧都用运行时默认区域自比。
 */
const ISO = "2026-09-22T15:04:05Z";

describe("formatDateTime", () => {
  test("日期 + 时刻：区域不同、串不同（字段与样式沿用 toLocaleString 的默认选择）", () => {
    expect(formatDateTime(ISO, { locale: "en-US", timeZone: "UTC" })).toBe("9/22/2026, 3:04:05 PM");
    expect(formatDateTime(ISO, { locale: "zh-CN", timeZone: "UTC" })).toBe("2026/9/22 15:04:05");
  });

  // 迁移契约：observer / sandbox 原先写的就是裸 `new Date(value).toLocaleString()`。这里把「不传 locale
  // 即运行时默认区域」钉住——改成给默认 locale 或给默认样式（如 dateStyle: "short"）会在这里露出来。
  test("不传 locale 时与不传参的 toLocaleString() 同输出（运行时默认区域）", () => {
    expect(formatDateTime(ISO, { timeZone: "UTC" })).toBe(new Date(ISO).toLocaleString(undefined, { timeZone: "UTC" }));
  });

  // timeZone 只为可测性与调用方显式口径存在：生产调用点不传，即本地时区。
  test("timeZone 选项生效：同一时刻在不同时区给出不同钟面", () => {
    expect(formatDateTime(ISO, { locale: "en-US", timeZone: "Asia/Shanghai" })).toBe("9/22/2026, 11:04:05 PM");
    expect(formatDateTime(ISO, { locale: "en-US", timeZone: "UTC" })).not.toBe(
      formatDateTime(ISO, { locale: "en-US", timeZone: "Asia/Shanghai" }),
    );
  });

  test("三种输入形态等价：ISO 串 / epoch 毫秒 / Date 实例", () => {
    const options = { locale: "en-US", timeZone: "UTC" } as const;
    const expected = formatDateTime(ISO, options);
    expect(formatDateTime(Date.parse(ISO), options)).toBe(expected);
    expect(formatDateTime(new Date(ISO), options)).toBe(expected);
  });

  // 空值与无效值：既不抛错，也不把 "Invalid Date" 渲染给用户。
  test("空值与无效值回退 fallback（缺省 —）", () => {
    for (const empty of [null, undefined, "", "not-a-date"]) {
      expect(formatDateTime(empty, { locale: "en-US", timeZone: "UTC" })).toBe("—");
    }
    expect(formatDateTime(null, { fallback: "无" })).toBe("无");
    expect(formatDateTime("not-a-date", { fallback: "-" })).toBe("-");
  });

  test("边界时刻：epoch 0 与年末最后一秒", () => {
    expect(formatDateTime(0, { locale: "en-US", timeZone: "UTC" })).toBe("1/1/1970, 12:00:00 AM");
    expect(formatDateTime("2026-12-31T23:59:59Z", { locale: "en-US", timeZone: "UTC" })).toBe(
      "12/31/2026, 11:59:59 PM",
    );
  });
});

describe("formatClockTime", () => {
  test("只给时刻，不含日期部分", () => {
    expect(formatClockTime(ISO, { locale: "en-US", timeZone: "UTC" })).toBe("3:04:05 PM");
    expect(formatClockTime(ISO, { locale: "zh-CN", timeZone: "UTC" })).toBe("15:04:05");
    // 原调用点是 observer 概览卡的「最后更新」卡片：那里只想要钟面，不该出现年月日。
    expect(formatClockTime(ISO, { locale: "zh-CN", timeZone: "UTC" })).not.toContain("2026");
  });

  test("空值与无效值回退 fallback（缺省 —）", () => {
    expect(formatClockTime("", { locale: "zh-CN" })).toBe("—");
    expect(formatClockTime("nope", { fallback: "-" })).toBe("-");
  });
});

describe("formatDate", () => {
  // 样式取自 identity 原先的 `formatApiKeyDate`（`Intl.DateTimeFormat` + 三个字段显式声明）。
  test("固定 short 月名样式：区域不同、串不同", () => {
    expect(formatDate(ISO, { locale: "en-US", timeZone: "UTC" })).toBe("Sep 22, 2026");
    expect(formatDate(ISO, { locale: "zh-CN", timeZone: "UTC" })).toBe("2026年9月22日");
  });

  test("与 formatDateTime 粒度不同：日期串里不含时刻", () => {
    expect(formatDate(ISO, { locale: "en-US", timeZone: "UTC" })).not.toContain("3:04");
  });

  test("空值与无效值回退调用方给的语义标签（区分「从未使用」与「永不过期」）", () => {
    expect(formatDate(null, { locale: "zh-CN", fallback: "永不过期" })).toBe("永不过期");
    expect(formatDate("invalid", { locale: "zh-CN", fallback: "—" })).toBe("—");
  });

  test("接受 epoch 毫秒：API 密钥契约是 number | string | null", () => {
    expect(formatDate(Date.parse(ISO), { locale: "en-US", timeZone: "UTC" })).toBe("Sep 22, 2026");
  });
});

describe("formatDurationMs / formatSeconds / formatInterval", () => {
  // 三个量级各自的形态：毫秒取整、秒留一位小数、分钟用 m/s 组合。
  test("时长按量级切换单位与精度", () => {
    expect(formatDurationMs(812)).toBe("812 ms");
    expect(formatDurationMs(2000)).toBe("2.0 s");
    expect(formatDurationMs(65_400)).toBe("1m 5s");
  });

  // 量级切换按原值判断：999.6 取整后是 1000，也必须留在毫秒档，否则单位会跳档。
  test("毫秒档取整到 1000 也不跳成秒档", () => {
    expect(formatDurationMs(999.6)).toBe("1000 ms");
    expect(formatDurationMs(1000)).toBe("1.0 s");
  });

  // 负时长只可能来自时钟回拨或上游脏数据：按「没有值」回退，比渲染 -3 ms 更能提示问题。
  test("缺失、非有限数与负数回退 fallback", () => {
    for (const empty of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(formatDurationMs(empty)).toBe("—");
    }
    expect(formatDurationMs(null, { fallback: "无" })).toBe("无");
  });

  // 上游以秒计量（latency / timeToFirstToken）：与毫秒口径同形，千分位以下同样落到毫秒档。
  test("formatSeconds 与 formatDurationMs 同口径，只是入参单位是秒", () => {
    expect(formatSeconds(1.24)).toBe("1.2 s");
    expect(formatSeconds(0.312)).toBe("312 ms");
    expect(formatSeconds(null)).toBe("—");
  });

  // 两次时间点相减：ISO 串与 epoch 毫秒是同一个值的两种写法，结果必须一致。
  test("formatInterval 接受 ISO 串与 epoch 毫秒", () => {
    const start = "2026-09-22T15:04:05Z";
    const end = "2026-09-22T15:04:06.500Z";
    expect(formatInterval(start, end)).toBe("1.5 s");
    expect(formatInterval(Date.parse(start), Date.parse(end))).toBe("1.5 s");
  });

  // 任一缺失 / 非法，或 end 早于 start（时钟倒挂），都回退——界面上不出现负时长。
  test("formatInterval 对缺失、非法与时钟倒挂回退 fallback", () => {
    expect(formatInterval(null, "2026-09-22T15:04:05Z")).toBe("—");
    expect(formatInterval("2026-09-22T15:04:05Z", "")).toBe("—");
    expect(formatInterval("nope", "2026-09-22T15:04:05Z")).toBe("—");
    expect(formatInterval("2026-09-22T15:04:05Z", "2026-09-22T15:04:04Z")).toBe("—");
  });
});

describe("formatTokens / formatCost", () => {
  // 断言显式给 locale：紧凑计数的刻度随区域变（zh-CN 是万 / 亿），不锁定就会随机器区域漂移。
  test("令牌数走紧凑计数，区域决定刻度", () => {
    expect(formatTokens(950, { locale: "en-US" })).toBe("950");
    expect(formatTokens(1234, { locale: "en-US" })).toBe("1.2K");
    expect(formatTokens(2_500_000, { locale: "en-US" })).toBe("2.5M");
    expect(formatTokens(12_500, { locale: "zh-CN" })).toBe("1.3万");
  });

  // 0 是有效值（新会话的令牌数就是 0），照常渲染，只有缺失才回退。
  test("令牌数 0 照常渲染，缺失回退 fallback", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(null)).toBe("—");
    expect(formatTokens(undefined, { fallback: "-" })).toBe("-");
  });

  // 一次真实计费不能显示成 $0.00（与「免费」无法区分），因此小额改用 3 位有效数字。
  test("金额按档位选精度，0 与缺失分得开", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.00213)).toBe("$0.00213");
    expect(formatCost(1.2)).toBe("$1.20");
    expect(formatCost(null)).toBe("—");
    expect(formatCost(-0.5)).toBe("—");
  });
});

describe("truncate", () => {
  // 阈值内与恰好阈值都原样保留，只有超长才补省略号（省略号不计入 max）。
  test("阈值内与边界长度不截断", () => {
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate("ab", 3)).toBe("ab");
    expect(truncate("abcd", 3)).toBe("abc…");
  });

  // 负数上限不做校验，按 String.prototype.slice 的语义走——2026-10-10 从 tool-call-utils 与 trace 面板
  // 合并时保留的既有行为，用例随实现迁移。
  test("负数上限按 slice 语义截断", () => {
    expect(truncate("abcd", -1)).toBe("abc…");
    expect(truncate("", -1)).toBe("…");
  });
});

// 契约守护：机制里不许长出 UI / i18n / 自己的展示形态。扫的是运行时代码，注释里的「为什么不做」不算。
test("模块不依赖 React / i18n / 宿主环境", () => {
  const source = readFileSync(join(import.meta.dir, "..", "lib", "format.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  for (const forbidden of ["react", "i18next", "sonner", "document", "window", "console"]) {
    expect(code.includes(forbidden), `原语的运行时代码里不应出现 ${forbidden}`).toBe(false);
  }
});
