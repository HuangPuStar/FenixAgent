import { describe, expect, test } from "bun:test";
import {
  getInvalidUploadSkillNames,
  getUploadConflictData,
  getUploadItemSummaries,
  getUploadResultMessage,
  normalizeSkillUploadResult,
  validateSkillForm,
} from "../pages/SkillsPage";
import type { SkillUploadConflictStrategy } from "../types/config";

// i18n mock: returns the key for English locale
const t = (key: string, params?: Record<string, unknown>) => {
  let result = key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      result = result.replace(`{{${k}}}`, String(v));
    }
  }
  return result;
};

describe("validateSkillForm", () => {
  test("empty name returns error", () => {
    expect(validateSkillForm("", "content", t)).toBe("form.nameRequired");
  });

  test("empty content returns error", () => {
    expect(validateSkillForm("my-skill", "", t)).toBe("form.contentRequired");
  });

  test("valid form returns null", () => {
    expect(validateSkillForm("my-skill", "# Hello", t)).toBeNull();
  });
});

describe("getUploadResultMessage", () => {
  test("only imported", () => {
    expect(getUploadResultMessage(2, 0, t)).toBe("toast.importResult");
  });

  test("imported with skipped", () => {
    expect(getUploadResultMessage(2, 1, t)).toBe("toast.importResultWithSkipped");
  });
});

describe("normalizeSkillUploadResult", () => {
  test("unwraps config success response", () => {
    const result = normalizeSkillUploadResult({
      success: true,
      data: { imported: [{ name: "a" }], skipped: [{ name: "b" }] },
    });
    expect(result.imported).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
  });

  test("defaults missing arrays to empty arrays", () => {
    const result = normalizeSkillUploadResult({ success: true, data: {} });
    expect(result.imported).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});

describe("getUploadConflictData", () => {
  test("extracts conflict payload from upload error", () => {
    const error = Object.assign(new Error("冲突"), {
      code: "SKILL_CONFLICT",
      data: {
        conflicts: [{ name: "existing", enabled: true, path: "/tmp/existing/SKILL.md" }],
        allowedStrategies: ["ignore", "overwrite"] as SkillUploadConflictStrategy[],
      },
    });
    expect(getUploadConflictData(error)).toEqual(error.data);
  });

  test("returns null for non-conflict error", () => {
    expect(getUploadConflictData(new Error("plain"))).toBeNull();
  });
});

describe("getUploadItemSummaries", () => {
  test("marks invalid item when SKILL.md is missing", () => {
    expect(
      getUploadItemSummaries(
        [
          { skillName: "skill-a", fileCount: 2, hasSkillMd: true, files: [] },
          { skillName: "broken", fileCount: 1, hasSkillMd: false, files: [] },
        ],
        t,
      ),
    ).toEqual(["upload.itemSummary", "upload.itemSummaryMissing"]);
  });
});

describe("getInvalidUploadSkillNames", () => {
  test("returns only invalid directory names", () => {
    expect(
      getInvalidUploadSkillNames([
        { skillName: "skill-a", fileCount: 2, hasSkillMd: true, files: [] },
        { skillName: "broken", fileCount: 1, hasSkillMd: false, files: [] },
      ]),
    ).toEqual(["broken"]);
  });
});
