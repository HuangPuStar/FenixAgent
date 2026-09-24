import { afterEach, describe, expect, mock, test } from "bun:test";
import { cronText } from "./cron-text-stub";

// Mock react-i18next before any component import
const t = cronText;

mock.module("react-i18next", () => ({
  useTranslation: () => ({
    t,
    i18n: { changeLanguage: () => new Promise(() => {}), language: "zh" },
  }),
  I18nextProvider: ({ children }: { children: unknown }) => children,
  initReactI18next: { type: "3rdParty", init: () => {} },
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));

const { describeCron } = await import("../pages/agent-panel/components/CronEditor");

afterEach(() => {
  mock.restore();
});

// 预设匹配 —— describeCron 经 t() 取字典里的预设文案
describe("describeCron presets", () => {
  test("每 5 分钟", () => {
    expect(describeCron("*/5 * * * *", t)).toBe("每 5 分钟");
  });

  test("每小时", () => {
    expect(describeCron("0 * * * *", t)).toBe("每小时");
  });

  test("每天上午 9:00", () => {
    expect(describeCron("0 9 * * *", t)).toBe("每天上午 9:00");
  });

  test("工作日上午 9:00", () => {
    expect(describeCron("0 9 * * 1-5", t)).toBe("工作日上午 9:00");
  });

  test("每月 1 号", () => {
    expect(describeCron("0 0 1 * *", t)).toBe("每月 1 号");
  });

  test("带空格 trim 后匹配", () => {
    expect(describeCron("  0 * * * *  ", t)).toBe("每小时");
  });
});

// 动态描述 —— 非预设的 cron 由四套字典模板 + 时段 / 星期字形拼出中文描述
describe("describeCron dynamic descriptions", () => {
  test("每 N 分钟", () => {
    expect(describeCron("*/10 * * * *", t)).toBe("每 10 分钟");
  });

  test("每天下午 3:30", () => {
    expect(describeCron("30 15 * * *", t)).toBe("每天下午 3:30");
  });

  test("每天中午 12:00", () => {
    expect(describeCron("0 12 * * *", t)).toBe("每天中午 12:00");
  });

  test("每天凌晨 0:00", () => {
    expect(describeCron("0 0 * * *", t)).toBe("每天上午 12:00");
  });

  test("每周一上午 9:00", () => {
    expect(describeCron("0 9 * * 1", t)).toBe("每周一上午 9:00");
  });

  test("每周一三五下午 6:00", () => {
    expect(describeCron("0 18 * * 1,3,5", t)).toBe("每周一、三、五下午 6:00");
  });

  test("每月 15 号上午 10:00", () => {
    expect(describeCron("0 10 15 * *", t)).toBe("每月 15 号上午 10:00");
  });

  test("未知模式返回 null", () => {
    expect(describeCron("1 2 3 4 5", t)).toBeNull();
  });
});

describe("describeCron edge cases", () => {
  test("空字符串返回 null", () => {
    expect(describeCron("", t)).toBeNull();
  });

  test("少于 5 段返回 null", () => {
    expect(describeCron("* * * *", t)).toBeNull();
  });

  test("多于 5 段返回 null", () => {
    expect(describeCron("* * * * * *", t)).toBeNull();
  });
});
