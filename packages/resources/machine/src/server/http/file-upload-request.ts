import { normalizeUploadRelativePath } from "../services/file-path-validator";
import { FileServiceError, type UploadFileInput } from "../services/file-types";

/** Parse per-file upload conditions before performing any writes in a batch. */
export async function parseUploadRequest(request: Request): Promise<{ inputs: UploadFileInput[]; overwrite: boolean }> {
  const rawOverwrite = new URL(request.url).searchParams.get("overwrite");
  const invalid = (message: string): never => {
    throw new FileServiceError(message, "validation_error", 400);
  };
  if (rawOverwrite !== null && rawOverwrite !== "true" && rawOverwrite !== "false")
    invalid("overwrite must be true or false");
  const overwrite = rawOverwrite === "true";
  const form = await request.formData();
  const files = form.getAll("files");
  if (!files.length || files.some((file) => typeof file === "string")) invalid("No files provided");
  let relativePaths: string[] = [];
  const rawPaths = form.get("relativePaths");
  if (typeof rawPaths === "string") {
    try {
      const parsed: unknown = JSON.parse(rawPaths);
      relativePaths = Array.isArray(parsed) ? parsed : [];
    } catch {
      relativePaths = [];
    }
  }
  // Keep legacy relative-path parsing, including rejecting unused malicious extra entries.
  if (relativePaths.some((path) => normalizeUploadRelativePath(path) === null))
    invalid("Invalid relativePath: must be a relative path without '..' segments or control characters");
  let conditions: Array<{ expectedVersion?: string }> = [];
  const rawConditions = form.get("fileConditions");
  if (rawConditions !== null) {
    if (!overwrite || typeof rawConditions !== "string") invalid("fileConditions requires overwrite=true");
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawConditions as string);
    } catch {
      invalid("Invalid fileConditions JSON");
    }
    if (!Array.isArray(parsed) || parsed.length !== files.length) invalid("fileConditions must match files length");
    conditions = (parsed as unknown[]).map((value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("Invalid file condition");
      const condition = value as Record<string, unknown>;
      if (
        Object.keys(condition).some((key) => key !== "expectedVersion") ||
        (condition.expectedVersion !== undefined &&
          (typeof condition.expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(condition.expectedVersion)))
      )
        invalid("Invalid file condition fields");
      return condition as { expectedVersion?: string };
    });
  }
  const inputs = await Promise.all(
    (files as File[]).map(async (file, index) => ({
      name: file.name ?? "",
      content: Buffer.from(await file.arrayBuffer()),
      relativePath: relativePaths[index],
      ...conditions[index],
    })),
  );
  return { inputs, overwrite };
}
