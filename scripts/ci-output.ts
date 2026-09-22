const TEST_FILE_HEADER = /^\S.*\.(?:test|spec)\.[cm]?[jt]sx?:$/;
const TEST_RESULT = /^\s*\((pass|fail|skip)\)/;
const SUMMARY_LINE = /^\s*\d+ (?:pass|fail|skip|errors?|expect\(\) calls)(?:\s|$)/;
const RUN_SUMMARY = /^Ran \d+ tests? /;
const UNHANDLED_ERROR = "# Unhandled error between tests";
const DIAGNOSTIC_SEPARATOR = /^-{3,}$/;
const ERROR_SIGNAL = /(?:^|\s)(?:error:|SyntaxError:|# Unhandled error)/i;
const TRUNCATION_MARKER = "\n\n[test output truncated]\n\n";

/** Maximum characters emitted for filtered test diagnostics. */
export const TEST_DIAGNOSTIC_MAX_CHARS = 6_000;

function trimOuterBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start]?.trim() === "") start += 1;
  while (end > start && lines[end - 1]?.trim() === "") end -= 1;

  return lines.slice(start, end);
}

function boundTestDiagnostic(output: string): string {
  if (output.length <= TEST_DIAGNOSTIC_MAX_CHARS) return output;

  const available = TEST_DIAGNOSTIC_MAX_CHARS - TRUNCATION_MARKER.length;
  const headLength = Math.ceil(available / 2);
  const tailLength = available - headLength;
  return `${output.slice(0, headLength)}${TRUNCATION_MARKER}${output.slice(-tailLength)}`;
}

/**
 * Reduces Bun test output to bounded failure diagnostics and final summary lines.
 * Passing-test output is discarded, while blank lines inside a failure are retained.
 * Startup errors without a Bun summary use the same bounded diagnostic fallback.
 */
export function filterTestSummary(out: string): string | null {
  const diagnosticBlocks: string[][] = [];
  const summary: string[] = [];
  let pending: string[] = [];
  let unhandled: string[] | null = null;
  let unhandledSeparators = 0;

  for (const line of out.replaceAll("\r\n", "\n").split("\n")) {
    if (SUMMARY_LINE.test(line) || RUN_SUMMARY.test(line)) {
      summary.push(line);
      continue;
    }

    if (unhandled) {
      unhandled.push(line);
      if (DIAGNOSTIC_SEPARATOR.test(line)) {
        unhandledSeparators += 1;
        if (unhandledSeparators === 2) {
          diagnosticBlocks.push(trimOuterBlankLines(unhandled));
          unhandled = null;
          unhandledSeparators = 0;
        }
      }
      continue;
    }

    if (line.includes(UNHANDLED_ERROR)) {
      unhandled = [...trimOuterBlankLines(pending), line];
      pending = [];
      continue;
    }

    const result = line.match(TEST_RESULT)?.[1];
    if (result === "fail") {
      diagnosticBlocks.push([...trimOuterBlankLines(pending), line]);
      pending = [];
      continue;
    }
    if (result === "pass" || result === "skip") {
      pending = [];
      continue;
    }

    if (TEST_FILE_HEADER.test(line)) {
      pending = [line];
      continue;
    }

    pending.push(line);
  }

  if (unhandled) diagnosticBlocks.push(trimOuterBlankLines(unhandled));

  const sections = diagnosticBlocks.map((block) => block.join("\n"));
  if (summary.length > 0) sections.push(summary.join("\n"));

  if (sections.length === 0) {
    // 注意：firstError 是行号，切片必须按行进行。此前误用 out.slice(firstError) 按字符切片，
    // 会让无摘要的失败输出从任意字符位置截起（从半行开始、丢失上文），掩盖真实错误。
    const lines = out.replaceAll("\r\n", "\n").split("\n");
    const firstError = lines.findIndex((line) => ERROR_SIGNAL.test(line));
    if (firstError === -1) return null;

    const fallback = trimOuterBlankLines(lines.slice(firstError)).join("\n");
    return boundTestDiagnostic(fallback);
  }

  return boundTestDiagnostic(sections.join("\n\n"));
}
