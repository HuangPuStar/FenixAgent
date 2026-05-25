import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { type Column, filterData, paginateData, sortData } from "../../components/config/DataTable";
import { intRangeSchema, nameSchema, optionalFloatSchema, validateWithSchema } from "../lib/form-utils";

// === DataTable edge cases ===

describe("DataTable adversarial: empty data", () => {
  const columns: Column<Record<string, string>>[] = [{ key: "name", header: "Name", filterable: true }];

  test("filterData on empty array returns empty", () => {
    expect(filterData([], columns, "test")).toHaveLength(0);
  });

  test("sortData on empty array returns empty", () => {
    expect(sortData([], "name", "asc")).toHaveLength(0);
  });

  test("paginateData on empty array returns empty items with 0 total", () => {
    const result = paginateData([], 1, 10);
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  test("paginateData with page 0", () => {
    const data = [{ name: "a" }, { name: "b" }];
    const result = paginateData(data, 0, 10);
    expect(result.items).toHaveLength(0);
  });

  test("paginateData with negative page", () => {
    const data = [{ name: "a" }];
    const result = paginateData(data, -1, 10);
    expect(result.items).toHaveLength(0);
  });
});

describe("DataTable adversarial: null/undefined values", () => {
  const columns: Column<Record<string, unknown>>[] = [{ key: "name", header: "Name", filterable: true }];

  test("filterData handles null/undefined values gracefully", () => {
    const data: Record<string, unknown>[] = [{ name: null }, { name: undefined }, { name: "valid" }];
    expect(filterData(data, columns, "valid")).toHaveLength(1);
  });

  test("sortData handles null/undefined values gracefully", () => {
    const data: Record<string, unknown>[] = [{ name: null }, { name: undefined }, { name: "alpha" }, { name: "beta" }];
    const sorted = sortData(data, "name", "asc");
    expect(sorted).toHaveLength(4);
  });
});

describe("DataTable adversarial: unicode and special characters", () => {
  const columns: Column<Record<string, string>>[] = [{ key: "name", header: "Name", filterable: true }];

  test("filterData with unicode characters", () => {
    const data = [{ name: "日本語テスト" }, { name: "中文测试" }, { name: "emoji 🎉" }];
    expect(filterData(data, columns, "日本")).toHaveLength(1);
    expect(filterData(data, columns, "🎉")).toHaveLength(1);
  });
});

// === form-utils edge cases ===

describe("form-utils adversarial: nameSchema edge cases", () => {
  test("rejects uppercase", () => {
    const result = nameSchema().safeParse("UPPERCASE");
    expect(result.success).toBe(false);
  });

  test("rejects spaces", () => {
    const result = nameSchema().safeParse("has space");
    expect(result.success).toBe(false);
  });

  test("rejects double hyphens", () => {
    const result = nameSchema().safeParse("a--b");
    expect(result.success).toBe(false);
  });

  test("rejects starting with hyphen", () => {
    const result = nameSchema().safeParse("-start");
    expect(result.success).toBe(false);
  });

  test("rejects empty string", () => {
    const result = nameSchema().safeParse("");
    expect(result.success).toBe(false);
  });

  test("accepts valid name", () => {
    const result = nameSchema().safeParse("my-agent-v2");
    expect(result.success).toBe(true);
  });

  test("rejects too long name", () => {
    const result = nameSchema().safeParse("a".repeat(65));
    expect(result.success).toBe(false);
  });
});

describe("form-utils adversarial: intRangeSchema edge cases", () => {
  test("rejects non-numeric string", () => {
    const result = intRangeSchema({ min: 1, max: 100 }).safeParse("abc");
    expect(result.success).toBe(false);
  });

  test("rejects negative when min is 1", () => {
    const result = intRangeSchema({ min: 1, max: 100 }).safeParse("-5");
    expect(result.success).toBe(false);
  });

  test("accepts valid integer", () => {
    const result = intRangeSchema({ min: 1, max: 100 }).safeParse("50");
    expect(result.success).toBe(true);
  });
});

describe("form-utils adversarial: optionalFloatSchema edge cases", () => {
  test("empty string returns undefined (valid)", () => {
    const result = optionalFloatSchema({ min: 0, max: 1 }).safeParse("");
    expect(result.success).toBe(true);
  });

  test("rejects out of range", () => {
    const result = optionalFloatSchema({ min: 0, max: 1 }).safeParse("2.0");
    expect(result.success).toBe(false);
  });

  test("rejects non-numeric", () => {
    const result = optionalFloatSchema({ min: 0, max: 1 }).safeParse("abc");
    expect(result.success).toBe(false);
  });
});

describe("form-utils adversarial: validateWithSchema", () => {
  test("returns null for valid data", () => {
    const schema = z.object({ name: z.string().min(1) });
    expect(validateWithSchema(schema, { name: "test" })).toBeNull();
  });

  test("returns error messages for invalid data", () => {
    const schema = z.object({ name: z.string().min(1) });
    const errors = validateWithSchema(schema, { name: "" });
    expect(errors).not.toBeNull();
    expect(errors!.length).toBeGreaterThan(0);
  });
});
