import { describe, expect, mock, test } from "bun:test";
import ReactDOMServer from "react-dom/server";
import { DatePicker } from "../../components/ui/date-picker";

mock.module("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        "datePicker.placeholder": "选择日期",
      };
      return map[key] ?? key;
    },
  }),
}));

describe("DatePicker", () => {
  test("renders with default placeholder when no value", () => {
    const html = ReactDOMServer.renderToStaticMarkup(<DatePicker />);
    expect(html).toContain("选择日期");
  });

  test("renders selected date when value provided", () => {
    const testDate = new Date("2025-06-15");
    const html = ReactDOMServer.renderToStaticMarkup(<DatePicker value={testDate} />);
    expect(html).toMatch(/2025|6/);
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
