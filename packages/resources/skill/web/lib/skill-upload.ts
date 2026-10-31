import type {
  SkillUploadConflictStrategy,
  UploadManifestEntry,
  UploadSkillFileItem,
  UploadSkillSummary,
} from "@fenix/web-runtime/types/config";
import type { TFunction } from "i18next";
import { isValidSkillName } from "../../src/skill-name";

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function buildUploadSummaries(files: File[], skillSegmentIndex: number): UploadSkillSummary[] {
  const grouped = new Map<string, UploadSkillFileItem[]>();

  for (const file of files) {
    const sourcePath = normalizeRelativePath(file.webkitRelativePath || file.name);
    const segments = sourcePath.split("/").filter(Boolean);
    if (segments.length <= skillSegmentIndex) {
      continue;
    }

    const skillName = segments[skillSegmentIndex];
    const relativePath = segments.slice(skillSegmentIndex + 1).join("/");
    if (!skillName || !relativePath) {
      continue;
    }

    const items = grouped.get(skillName) ?? [];
    items.push({ relativePath, file });
    grouped.set(skillName, items);
  }

  return [...grouped.entries()].map(([skillName, groupedFiles]) => ({
    skillName,
    fileCount: groupedFiles.length,
    hasSkillMd: groupedFiles.some((item) => item.relativePath === "SKILL.md"),
    files: groupedFiles,
  }));
}

export function parseSkillUploadFiles(files: File[]): UploadSkillSummary[] {
  const topLevelItems = buildUploadSummaries(files, 0);
  if (topLevelItems.length !== 1 || topLevelItems[0]?.hasSkillMd) {
    return topLevelItems;
  }

  const nestedItems = buildUploadSummaries(files, 1);
  return nestedItems.length > 0 ? nestedItems : topLevelItems;
}

/** 校验实际导入的目录，并使用界面语言报告批次错误。 */
export function validateUploadBatch(items: UploadSkillSummary[], t: TFunction): string | null {
  if (items.length === 0) {
    return t("upload.noSkillFolders");
  }

  const validItems = items.filter((item) => item.hasSkillMd);
  const missingSkillMd = items.filter((item) => !item.hasSkillMd).map((item) => item.skillName);
  if (validItems.length === 0 && missingSkillMd.length > 0) {
    return t("upload.missingSkillMdIn", { names: missingSkillMd.join(", ") });
  }

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of validItems) {
    const normalizedName = item.skillName.trim().toLowerCase();
    if (seen.has(normalizedName)) {
      duplicates.add(item.skillName);
      continue;
    }
    seen.add(normalizedName);
  }
  if (duplicates.size > 0) {
    return t("upload.duplicateSkillNames", { names: [...duplicates].join(", ") });
  }

  const invalidNames = validItems.filter((item) => !isValidSkillName(item.skillName)).map((item) => item.skillName);
  if (invalidNames.length > 0) {
    return t("upload.invalidSkillNames", { names: invalidNames.join(", "), format: t("form.nameInvalid") });
  }

  return null;
}

export function buildSkillUploadFormData(
  items: UploadSkillSummary[],
  strategy?: SkillUploadConflictStrategy,
): FormData {
  const formData = new FormData();
  const manifest: UploadManifestEntry[] = [];

  for (const item of items.filter((entry) => entry.hasSkillMd)) {
    for (const file of item.files) {
      manifest.push({ skillName: item.skillName, relativePath: file.relativePath });
      formData.append("files", file.file);
    }
  }

  formData.append("manifest", JSON.stringify(manifest));
  if (strategy) {
    formData.append("conflictStrategy", strategy);
  }
  return formData;
}
