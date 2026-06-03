import Elysia from "elysia";
import { auth } from "../../auth/better-auth";
import { authGuardPlugin, errorResponse } from "../../plugins/auth";
import { bindSessionOwner, resolveExistingSessionId } from "../../services/session";
import { decryptPassword } from "../../auth/encryption";

const app = new Elysia({ name: "web-auth" }).use(authGuardPlugin).decorate({ error: errorResponse });

/** POST /web/bind — Bind a session to a user (requires session auth) */
app.post(
  "/bind",
  async ({ store, body, query, error }) => {
    const user = store.user;
    if (!user) {
      return error(401, { error: "Not authenticated" });
    }

    const b = body as { sessionId?: string; uuid?: string };
    const sessionId = b.sessionId;
    const uuid = (query as Record<string, string | undefined>)?.uuid || b.uuid;

    if (!sessionId || !uuid) {
      return error(400, { error: "sessionId and uuid are required" });
    }

    const authCtx = store.authContext;
    if (!authCtx) {
      return error(403, { error: "No organization context" });
    }

    const resolvedSessionId = await resolveExistingSessionId(sessionId);
    if (!resolvedSessionId) {
      return error(404, { error: "Session not found" });
    }

    await bindSessionOwner(resolvedSessionId, uuid);
    return { ok: true, sessionId: resolvedSessionId };
  },
  { sessionAuth: true },
);

/** POST /web/change-password — Change user password (requires session auth) */
app.post(
  "/change-password",
  async ({ store, body, request }) => {
    const user = store.user;

    if (!user) {
      return { error: "Not authenticated", code: 401 };
    }

    const b = body as { oldPassword?: string; newPassword?: string };

    const oldPassword = b.oldPassword;
    const newPassword = b.newPassword;

    if (!oldPassword || !newPassword) {
      return { error: "Old password and new password are required", code: 400 };
    }

    try {
      console.log('[Change Password Debug] Request:', {
        userId: user.id,
        email: user.email,
        organizationId: store.authContext?.organizationId,
        timestamp: new Date().toISOString(),
      });

      console.log('[Change Password Debug] Received passwords:', {
        oldPasswordLength: oldPassword.length,
        newPasswordLength: newPassword.length,
        oldPasswordStart: oldPassword.substring(0, 20),
        newPasswordStart: newPassword.substring(0, 20),
      });

      const decryptedOldPassword = decryptPassword(oldPassword);
      const decryptedNewPassword = decryptPassword(newPassword);
      console.log('[Change Password Debug] Decrypted passwords:', {
        oldPasswordLength: decryptedOldPassword.length,
        newPasswordLength: decryptedNewPassword.length,
        oldPasswordStart: decryptedOldPassword.substring(0, 10),
        newPasswordStart: decryptedNewPassword.substring(0, 10),
      });

      console.log('[Change Password Debug] Calling changePassword API...');
      const { data, error: changePasswordError } = await auth.api.changePassword({
        body: {
          newPassword: decryptedNewPassword,
          currentPassword: decryptedOldPassword,
          revokeOtherSessions: true,
        },
        headers: request.headers,
      });

      if (changePasswordError) {
        console.error('[Change Password Error] Password change failed:', {
          userId: user.id,
          error: changePasswordError.message,
          errorType: changePasswordError.name,
          timestamp: new Date().toISOString(),
        });
        return { error: changePasswordError.message, code: 400 };
      }

      console.log('[Change Password Success] Password changed successfully:', {
        userId: user.id,
        email: user.email,
        timestamp: new Date().toISOString(),
      });

      return { success: true, data: { userId: user.id } };
    } catch (err) {
      console.error('[Change Password Exception] Unexpected error:', {
        userId: user.id,
        error: err instanceof Error ? err.message : "Unknown error",
        stack: err instanceof Error ? err.stack : undefined,
        timestamp: new Date().toISOString(),
      });
      return { error: err instanceof Error ? err.message : "Unknown error", code: 500 };
    }
  },
  { sessionAuth: true },
);

export default app;
