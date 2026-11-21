import { EditingError } from "@fenix/file-editing/contracts";
import { createLogger } from "@fenix/logger";
import { z } from "zod/v4";
import type { MachineFileActor } from "../facades/machine-file-facade";
import { FileServiceError } from "../services/file-types";

const logger = createLogger("machine-file-editing");
const ActorSchema = z.object({
  organizationId: z.string().min(1),
  userId: z.string().min(1),
  role: z.enum(["owner", "admin", "member"]).optional(),
});

/** Guard state is validated at the protocol boundary instead of trusting framework casts. */
export function editingActor(store: unknown): MachineFileActor {
  const parsed = z.object({ authContext: ActorSchema }).safeParse(store);
  if (!parsed.success) throw new EditingError("forbidden", "Authentication required");
  return parsed.data.authContext;
}

/** Normalize expected failures without logging provider tokens, response URLs or document content. */
export function editingFailure(error: unknown): Response {
  let status = 503;
  let code = "unavailable";
  let message = "File editing is temporarily unavailable";
  if (error instanceof EditingError) {
    code = error.code;
    message = error.message;
    status = {
      conflict: 409,
      "not-found": 404,
      forbidden: 403,
      unavailable: 503,
      "too-large": 413,
      "not-editable": 400,
      busy: 429,
      expired: 410,
      "invalid-input": 400,
    }[error.code];
  } else if (error instanceof FileServiceError) {
    status = error.statusCode;
    code = error.type;
    message = error.message;
  } else {
    logger.error("Editing request failed", { errorType: error instanceof Error ? error.name : "UnknownError" });
  }
  return Response.json(
    { success: false, error: { code, message } },
    { status, headers: { "Cache-Control": "no-store", ...(status === 429 ? { "Retry-After": "1" } : {}) } },
  );
}

/** Session actions share one success/error envelope. */
export async function editingResponse<T>(operation: () => Promise<T>) {
  try {
    return { success: true as const, data: await operation() };
  } catch (error) {
    return editingFailure(error);
  }
}
