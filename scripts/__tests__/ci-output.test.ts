import { describe, expect, test } from "bun:test";

import { filterTestSummary, TEST_DIAGNOSTIC_MAX_CHARS } from "../ci-output";

describe("filterTestSummary", () => {
  // 成功输出只保留 Bun 汇总，不泄漏通过用例和运行噪声。
  test("keeps only the summary for successful output", () => {
    const output = filterTestSummary(`bun test v1.3.13

example.test.ts:
(pass) example > succeeds [1.00ms]

 1 pass
 0 fail
 1 expect() calls
Ran 1 test across 1 file. [2.00ms]
`);

    expect(output).toBe(" 1 pass\n 0 fail\n 1 expect() calls\nRan 1 test across 1 file. [2.00ms]");
  });

  // 失败详情即使包含多个空行，也必须完整保留源码、差异、堆栈和最终汇总。
  test("keeps complete failure diagnostics across blank lines", () => {
    const output = filterTestSummary(`bun test v1.3.13

example.test.ts:
(pass) example > unrelated success [1.00ms]
11 | const actual = runSubject();
12 |
13 | expect(actual).toBe("expected");
     ^
error: expect(received).toBe(expected)

Expected: "expected"
Received: "actual"

- expected
+ actual

      at <anonymous> (/repo/example.test.ts:13:20)

(fail) example > reports a useful failure [2.00ms]

 1 pass
 1 fail
 2 expect() calls
Ran 2 tests across 1 file. [4.00ms]
`);

    expect(output).not.toContain("unrelated success");
    expect(output).toContain("11 | const actual = runSubject();");
    expect(output).toContain('13 | expect(actual).toBe("expected");');
    expect(output).toContain("error: expect(received).toBe(expected)");
    expect(output).toContain('Expected: "expected"');
    expect(output).toContain('Received: "actual"');
    expect(output).toContain("- expected");
    expect(output).toContain("+ actual");
    expect(output).toContain("at <anonymous> (/repo/example.test.ts:13:20)");
    expect(output).toContain("(fail) example > reports a useful failure");
    expect(output).toContain(" 1 pass\n 1 fail\n 2 expect() calls\nRan 2 tests across 1 file.");
  });

  // 加载阶段的未处理 SyntaxError 必须跨空行保留源码和堆栈。
  test("keeps complete unhandled error diagnostics", () => {
    const output = filterTestSummary(`bun test v1.3.13

broken.test.ts:

# Unhandled error between tests
-------------------------------
1 | import { missing } from "./subject";
2 |
3 | missing();
    ^

SyntaxError: Export named 'missing' not found in module './subject'.

      at loadAndEvaluateModule (2:1)
-------------------------------

 0 pass
 1 fail
 1 error
Ran 0 tests across 1 file. [1.00ms]
`);

    expect(output).toContain("# Unhandled error between tests");
    expect(output).toContain('1 | import { missing } from "./subject";');
    expect(output).toContain("3 | missing();");
    expect(output).toContain("SyntaxError: Export named 'missing' not found");
    expect(output).toContain("at loadAndEvaluateModule (2:1)");
    expect(output).toContain(" 0 pass\n 1 fail\n 1 error\nRan 0 tests across 1 file.");
  });

  // preload 等启动错误即使没有 Bun 汇总，也必须返回可定位的错误诊断。
  test("keeps startup errors without a test summary", () => {
    const output = filterTestSummary(`bun test v1.3.13

error: preload not found: ./definitely-missing-phy10-preload.ts
      at loadPreload (/repo/runtime.ts:10:2)
`);

    expect(output).toContain("error: preload not found: ./definitely-missing-phy10-preload.ts");
    expect(output).toContain("at loadPreload (/repo/runtime.ts:10:2)");
  });

  // 无汇总错误过长时必须有界，并明确标记截断且保留首尾错误上下文。
  test("bounds oversized startup errors without losing first and last context", () => {
    const middle = Array.from({ length: 500 }, (_, index) => `diagnostic line ${index} ${"x".repeat(40)}`).join("\n");
    const output = filterTestSummary(`error: first preload failure\n${middle}\nerror: final preload failure`);

    expect(output).toContain("error: first preload failure");
    expect(output).toContain("[test output truncated]");
    expect(output).toContain("error: final preload failure");
    expect(output?.length).toBeLessThanOrEqual(TEST_DIAGNOSTIC_MAX_CHARS);
  });
});
