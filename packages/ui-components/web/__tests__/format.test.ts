import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatClockTime, formatDate, formatDateTime } from "@fenix/ui-components/lib/format";

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

// 契约守护：机制里不许长出 UI / i18n / 自己的展示形态。扫的是运行时代码，注释里的「为什么不做」不算。
test("模块不依赖 React / i18n / 宿主环境", () => {
  const source = readFileSync(join(import.meta.dir, "..", "lib", "format.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  for (const forbidden of ["react", "i18next", "sonner", "document", "window", "console"]) {
    expect(code.includes(forbidden), `原语的运行时代码里不应出现 ${forbidden}`).toBe(false);
  }
});
