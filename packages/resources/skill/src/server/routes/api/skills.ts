import { error as logError } from "@fenix/logger";
import { type ActorContext, ApiV1ErrSchema, ApiV1OkSchema, AppError, ValidationError } from "@fenix/platform-sdk";
import Elysia from "elysia";
import {
  ApiSkillDeleteResponseSchema,
  ApiSkillDetailSchema,
  ApiSkillIdParamsSchema,
  ApiSkillListQuerySchema,
  ApiSkillListResponseSchema,
  ApiSkillUpdateBodySchema,
} from "../../schemas/api-skill.schema";
import { ApiV1SkillService } from "../../services/api-v1-skill";
import type { SkillRouteDependencies } from "../dependencies";
import { readSkillUploadForm } from "../skill-upload-form";

/** v1 Skill transport; all content operations remain in the resource owner. */
export function createApiSkillsRoutes(deps: SkillRouteDependencies) {
  const service = new ApiV1SkillService();
  const errors = {
    400: ApiV1ErrSchema,
    401: ApiV1ErrSchema,
    403: ApiV1ErrSchema,
    404: ApiV1ErrSchema,
    409: ApiV1ErrSchema,
    500: ApiV1ErrSchema,
  };
  return new Elysia({ name: "api-skills", prefix: "/api/v1/skills" })
    .use(deps.authGuardPlugin)
    .onError(({ error, code, set }) => {
      if (code !== "VALIDATION" && !(error instanceof AppError)) logError("[api-skills] Request failed", error);
      set.status = code === "VALIDATION" ? 400 : error instanceof AppError ? error.statusCode : 500;
      return {
        success: false as const,
        error: {
          code: code === "VALIDATION" ? "VALIDATION_ERROR" : error instanceof AppError ? error.code : "INTERNAL_ERROR",
          message:
            code === "VALIDATION"
              ? "Invalid request"
              : error instanceof AppError && error.statusCode < 500
                ? error.message
                : "Internal server error",
        },
      };
    })
    .get(
      "",
      async ({ store, query }) => ({
        success: true as const,
        data: await service.list(requireActor(store.actor as ActorContext | null), query),
      }),
      {
        sessionAuth: true,
        query: ApiSkillListQuerySchema,
        response: { 200: ApiV1OkSchema(ApiSkillListResponseSchema), ...errors },
        detail: { tags: ["External Skill"], summary: "查询 Skill" },
      },
    )
    .get(
      "/:id",
      async ({ store, params }) => ({
        success: true as const,
        data: await service.get(requireActor(store.actor as ActorContext | null), params.id),
      }),
      {
        sessionAuth: true,
        params: ApiSkillIdParamsSchema,
        response: { 200: ApiV1OkSchema(ApiSkillDetailSchema), ...errors },
        detail: { tags: ["External Skill"], summary: "Skill 详情" },
      },
    )
    .post(
      "",
      async ({ store, request, set }) => {
        const actor = requireActor(store.actor as ActorContext | null);
        const { files, formData } = await readSkillUploadForm(request);
        const overwrite = formData.get("overwrite");
        if (overwrite !== null && overwrite !== "true" && overwrite !== "false")
          throw new ValidationError("Invalid overwrite");
        const result = await service.import(actor, files, overwrite === "true");
        set.status = result.created ? 201 : 200;
        return { success: true as const, data: result.data };
      },
      {
        sessionAuth: true,
        parse: "none",
        response: { 200: ApiV1OkSchema(ApiSkillDetailSchema), 201: ApiV1OkSchema(ApiSkillDetailSchema), ...errors },
        detail: {
          tags: ["External Skill"],
          summary: "导入 Skill",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object" as const,
                  required: ["manifest", "files"],
                  properties: {
                    manifest: { type: "string" as const },
                    files: { type: "array" as const, items: { type: "string" as const, format: "binary" } },
                    overwrite: { type: "string" as const, enum: ["true", "false"] },
                  },
                },
              },
            },
          },
        },
      },
    )
    .patch(
      "/:id",
      async ({ store, params, body }) => ({
        success: true as const,
        data: await service.patch(requireActor(store.actor as ActorContext | null), params.id, body),
      }),
      {
        sessionAuth: true,
        params: ApiSkillIdParamsSchema,
        body: ApiSkillUpdateBodySchema,
        response: { 200: ApiV1OkSchema(ApiSkillDetailSchema), ...errors },
        detail: { tags: ["External Skill"], summary: "更新 Skill" },
      },
    )
    .delete(
      "/:id",
      async ({ store, params }) => ({
        success: true as const,
        data: await service.remove(requireActor(store.actor as ActorContext | null), params.id),
      }),
      {
        sessionAuth: true,
        params: ApiSkillIdParamsSchema,
        response: { 200: ApiV1OkSchema(ApiSkillDeleteResponseSchema), ...errors },
        detail: { tags: ["External Skill"], summary: "删除 Skill" },
      },
    );
}

/** Reject missing authenticated organization before invoking resource actions. */
function requireActor(actor: ActorContext | null): ActorContext {
  if (!actor) throw new AppError("请求缺少组织上下文", "UNAUTHORIZED", 401);
  return actor;
}
