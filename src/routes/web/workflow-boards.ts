/**
 * Workflow Boards API 路由。
 *
 * POST /web/workflow-boards — action ���发，管理看板面板的创建、查询、重命名、删除。
 */

import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import {
  createBoard,
  deleteBoard,
  ensureDefaultBoard,
  getBoard,
  listBoards,
  updateBoard,
} from "../../repositories/workflow-board";

const app = new Elysia({ name: "web-workflow-boards" }).use(authGuardPlugin);

app.post(
  "/workflow-boards",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    const payload = body as Record<string, unknown>;
    const action = payload.action as string;

    try {
      switch (action) {
        case "list": {
          let boards = await listBoards(authCtx.organizationId);
          if (boards.length === 0) {
            await ensureDefaultBoard(authCtx.organizationId, authCtx.userId);
            boards = await listBoards(authCtx.organizationId);
          }
          return { success: true, data: boards };
        }

        case "get": {
          const boardId = payload.boardId as string;
          if (!boardId) return error(400, { error: { type: "VALIDATION_ERROR", message: "boardId is required" } });
          const board = await getBoard(boardId, authCtx.organizationId);
          if (!board) return error(404, { error: { type: "NOT_FOUND", message: "Board not found" } });
          return { success: true, data: board };
        }

        case "create": {
          const name = payload.name as string;
          if (!name?.trim()) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "name is required" } });
          }
          try {
            const board = await createBoard(authCtx.organizationId, authCtx.userId, { name: name.trim() });
            return { success: true, data: board };
          } catch (err: unknown) {
            if (String(err).includes("idx_workflow_board_org_name")) {
              return error(409, { error: { type: "CONFLICT", message: "Board name already exists" } });
            }
            throw err;
          }
        }

        case "update": {
          const boardId = payload.boardId as string;
          const name = payload.name as string;
          if (!boardId) return error(400, { error: { type: "VALIDATION_ERROR", message: "boardId is required" } });
          if (!name?.trim()) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "name is required" } });
          }
          const board = await getBoard(boardId, authCtx.organizationId);
          if (!board) return error(404, { error: { type: "NOT_FOUND", message: "Board not found" } });
          if (board.userId !== authCtx.userId) {
            return error(403, { error: { type: "FORBIDDEN", message: "Only the board owner can rename it" } });
          }
          try {
            const ok = await updateBoard(boardId, authCtx.organizationId, name.trim());
            if (!ok) return error(404, { error: { type: "NOT_FOUND", message: "Board not found" } });
            return { success: true };
          } catch (err: unknown) {
            if (String(err).includes("idx_workflow_board_org_name")) {
              return error(409, { error: { type: "CONFLICT", message: "Board name already exists" } });
            }
            throw err;
          }
        }

        case "delete": {
          const boardId = payload.boardId as string;
          if (!boardId) return error(400, { error: { type: "VALIDATION_ERROR", message: "boardId is required" } });
          const board = await getBoard(boardId, authCtx.organizationId);
          if (!board) return error(404, { error: { type: "NOT_FOUND", message: "Board not found" } });
          if (board.userId !== authCtx.userId) {
            return error(403, { error: { type: "FORBIDDEN", message: "Only the board owner can delete it" } });
          }
          if (board.isDefault) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "Cannot delete the default board" } });
          }
          const deleted = await deleteBoard(boardId, authCtx.organizationId);
          return { success: true, data: deleted };
        }

        default:
          return error(400, { error: { type: "VALIDATION_ERROR", message: `Unknown action: ${action}` } });
      }
    } catch (err: unknown) {
      console.error("[workflow-boards] Error:", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      return error(500, { error: { type: "INTERNAL_ERROR", message } });
    }
  },
  { sessionAuth: true },
);

export default app;
