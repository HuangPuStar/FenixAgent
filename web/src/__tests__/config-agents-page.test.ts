import { describe, test, expect } from "bun:test";
import { isValidAgentNameInput, isValidStepsInput } from "../pages/AgentsPage";

describe("isValidAgentNameInput", () => {
  test("valid name", () => {
    expect(isValidAgentNameInput("my-agent")).toBe(true);
  });

  test("uppercase rejected", () => {
    expect(isValidAgentNameInput("MY-AGENT")).toBe(false);
  });

  test("single char valid", () => {
    expect(isValidAgentNameInput("a")).toBe(true);
  });

  test("double hyphen rejected", () => {
    expect(isValidAgentNameInput("a--b")).toBe(false);
  });

  test("empty rejected", () => {
    expect(isValidAgentNameInput("")).toBe(false);
  });
});

describe("isValidStepsInput", () => {
  test("valid steps", () => {
    expect(isValidStepsInput("50")).toBe(true);
  });

  test("zero rejected", () => {
    expect(isValidStepsInput("0")).toBe(false);
  });

  test("over 200 rejected", () => {
    expect(isValidStepsInput("201")).toBe(false);
  });

  test("non-number rejected", () => {
    expect(isValidStepsInput("abc")).toBe(false);
  });
});
