import { describe, expect, test } from "bun:test";
import { getBadgeVariant } from "../../components/config/StatusBadge";

describe("getBadgeVariant", () => {
  test("configured → green", () => {
    expect(getBadgeVariant("configured")).toBe("green");
  });

  test("enabled → green", () => {
    expect(getBadgeVariant("enabled")).toBe("green");
  });

  test("disabled → secondary", () => {
    expect(getBadgeVariant("disabled")).toBe("secondary");
  });

  test("unconfigured → secondary", () => {
    expect(getBadgeVariant("unconfigured")).toBe("secondary");
  });

  test("builtIn → blue", () => {
    expect(getBadgeVariant("builtIn")).toBe("blue");
  });

  test("unknown → outline", () => {
    expect(getBadgeVariant("unknown")).toBe("outline");
  });
});
