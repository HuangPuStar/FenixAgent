import { describe, expect, test } from "bun:test";
import { getStatusTone, type StatusTone } from "@fenix/ui-components/config/StatusBadge";

/** 业务私有词表：模拟任务日志的状态集合。 */
const LOG_TONES: Record<string, StatusTone> = {
  success: "success",
  failed: "danger",
  pending: "warning",
};

describe("getStatusTone", () => {
  // 内置词表覆盖包内通用状态
  test("内置词表：configured → success", () => {
    expect(getStatusTone("configured")).toBe("success");
  });

  // builtIn 是「内置」语义，与宿主自定义项区分，用 info 而非 success
  test("内置词表：builtIn → info", () => {
    expect(getStatusTone("builtIn")).toBe("info");
  });

  // 未命中一律中性：新状态上线不应默认报红
  test("未知状态回退 neutral", () => {
    expect(getStatusTone("unknown")).toBe("neutral");
  });

  // 业务词表优先于内置词表，否则业务无法表达同名词的另一种语义
  test("toneMap 覆盖内置词表", () => {
    expect(getStatusTone("configured", { configured: "danger" })).toBe("danger");
  });

  // 业务词表只补自己的状态，未在表内的仍走内置/回退
  test("toneMap 未命中的词仍走内置词表", () => {
    expect(getStatusTone("enabled", LOG_TONES)).toBe("success");
    expect(getStatusTone("mystery", LOG_TONES)).toBe("neutral");
  });

  // 业务状态按语义取色，而不是按字符串猜
  test("业务状态映射到各自色调", () => {
    expect(getStatusTone("failed", LOG_TONES)).toBe("danger");
    expect(getStatusTone("pending", LOG_TONES)).toBe("warning");
  });
});
