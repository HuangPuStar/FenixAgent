import { describe, test, expect } from "bun:test";
import { filterData, sortData, paginateData, type Column } from "../../components/config/DataTable";

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
