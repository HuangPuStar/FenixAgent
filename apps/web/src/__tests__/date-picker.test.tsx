// DatePicker 的 owner 已归 `@fenix/ui-components`（§1.6 T8a 删除宿主副本）。断言的契约随之换成
// 包内契约：宿主副本曾用 `useTranslation("datePicker.placeholder")` 取默认占位，包内明确定义为
// 「英文默认文案 + 调用方 placeholder 覆盖，不自带 i18n 单例、不读取宿主文案」，
// 本地化改由 `locale` prop 承担。该宿主副本零生产消费方，故此处按包契约断言。
import { describe, expect, test } from "bun:test";
import { DatePicker } from "@fenix/ui-components/ui/date-picker";
import ReactDOMServer from "react-dom/server";

describe("DatePicker", () => {
  test("renders the package default placeholder when no value", () => {
    const html = ReactDOMServer.renderToStaticMarkup(<DatePicker />);
    expect(html).toContain("Select date");
  });

  test("renders selected date when value provided", () => {
    const testDate = new Date("2025-06-15");
    const html = ReactDOMServer.renderToStaticMarkup(<DatePicker value={testDate} />);
    expect(html).toMatch(/2025|6/);
  });

  // `locale` 是包契约里承担本地化的唯一入口（宿主副本的 i18n 路径已随副本删除）。
  test("formats the selected date with the locale prop", () => {
    const testDate = new Date("2025-06-15");
    const html = ReactDOMServer.renderToStaticMarkup(<DatePicker value={testDate} locale="en-US" />);
    expect(html).toContain("6/15/2025");
  });

  test("renders custom placeholder", () => {
    const html = ReactDOMServer.renderToStaticMarkup(<DatePicker placeholder="Pick a date" />);
    expect(html).toContain("Pick a date");
  });

  test("renders as disabled", () => {
    const html = ReactDOMServer.renderToStaticMarkup(<DatePicker disabled />);
    expect(html).toContain("disabled");
  });

  test("exports DatePicker component", () => {
    expect(typeof DatePicker).toBe("function");
  });
});
