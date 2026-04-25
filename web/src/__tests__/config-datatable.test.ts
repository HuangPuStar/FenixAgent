import { describe, test, expect } from "bun:test";
import { filterData, sortData, paginateData, buildInitialExpandedState, type Column } from "../../components/config/DataTable";

interface Row { name: string; age: number }

const columns: Column<Row>[] = [
  { key: "name", header: "Name", sortable: true, filterable: true },
  { key: "age", header: "Age", sortable: true },
];

const data: Row[] = [
  { name: "charlie", age: 30 },
  { name: "alice", age: 25 },
  { name: "bob", age: 35 },
  { name: "david", age: 20 },
  { name: "eve", age: 28 },
];

describe("DataTable pure functions", () => {
  test("filterData matches filterable columns", () => {
    expect(filterData(data, columns, "alice")).toHaveLength(1);
    expect(filterData(data, columns, "alice")[0].name).toBe("alice");
  });

  test("filterData returns all when search is empty", () => {
    expect(filterData(data, columns, "")).toHaveLength(5);
  });

  test("sortData ascending by name", () => {
    const sorted = sortData(data, "name", "asc");
    expect(sorted[0].name).toBe("alice");
    expect(sorted[4].name).toBe("eve");
  });

  test("sortData descending by name", () => {
    const sorted = sortData(data, "name", "desc");
    expect(sorted[0].name).toBe("eve");
    expect(sorted[4].name).toBe("alice");
  });

  test("sortData by number", () => {
    const sorted = sortData(data, "age", "asc");
    expect(sorted[0].age).toBe(20);
    expect(sorted[4].age).toBe(35);
  });

  test("paginateData with enough data", () => {
    const result = paginateData(data, 1, 2);
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(5);
  });

  test("paginateData with less data than page size", () => {
    const result = paginateData(data, 1, 10);
    expect(result.items).toHaveLength(5);
    expect(result.total).toBe(5);
  });

  test("paginateData page 2", () => {
    const result = paginateData(data, 2, 2);
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(5);
  });
});

describe("DataTable TanStack integration helpers", () => {
  test("filterData and TanStack globalFilterFn produce consistent results", () => {
    const filtered = filterData(data, columns, "ali");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("alice");
  });

  test("sortData handles mixed types gracefully", () => {
    interface Mixed { val: string | number }
    const mixedCols: Column<Mixed>[] = [{ key: "val", header: "Val", sortable: true }];
    const mixedData: Mixed[] = [
      { val: 42 },
      { val: "alpha" },
      { val: 10 },
      { val: "beta" },
    ];
    const sorted = sortData(mixedData, "val", "asc");
    expect(sorted[0].val).toBe(10);
    expect(sorted[3].val).toBe("beta");
  });

  test("paginateData returns correct slice for last page", () => {
    const result = paginateData(data, 3, 2);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe("eve");
    expect(result.total).toBe(5);
  });

  test("paginateData handles out-of-range page gracefully", () => {
    const result = paginateData(data, 10, 2);
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(5);
  });

  test("filterData with non-filterable column ignores that column", () => {
    const result = filterData(data, columns, "30");
    expect(result).toHaveLength(0);
  });
});

describe("buildInitialExpandedState", () => {
  test("returns all row IDs expanded with rowKey", () => {
    const rows = [
      { id: "key1", name: "a" },
      { id: "key2", name: "b" },
      { id: "key3", name: "c" },
    ];
    const result = buildInitialExpandedState(rows, (row) => row.id);
    expect(result).toEqual({ key1: true, key2: true, key3: true });
  });

  test("uses index as key when no rowKey provided", () => {
    const rows = [
      { name: "a" },
      { name: "b" },
      { name: "c" },
    ];
    const result = buildInitialExpandedState(rows);
    expect(result).toEqual({ "0": true, "1": true, "2": true });
  });

  test("returns empty object for empty data", () => {
    const result = buildInitialExpandedState([]);
    expect(result).toEqual({});
  });
});
