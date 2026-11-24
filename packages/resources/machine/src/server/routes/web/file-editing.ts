import Elysia from "elysia";
import { z } from "zod/v4";
import {
  EditingCapabilitiesSchema,
  EditingErrorResponseSchema,
  EditingSessionParamsSchema,
  EditingSessionSchema,
  EditingSessionStatusSchema,
  OpenEditingSessionSchema,
} from "../../../schemas/file-editing.schema";
import { editingActor, editingResponse } from "../../editing/editing-http";
import { type MachineFileEditingFacade, machineFileEditingFacade } from "../../facades/file-editing-facade";
import type { WebMachineRouteDependencies } from "../dependencies";

const ok = <T extends z.ZodType>(schema: T) => z.object({ success: z.literal(true), data: schema });
const errors = {
  400: EditingErrorResponseSchema,
  403: EditingErrorResponseSchema,
  404: EditingErrorResponseSchema,
  409: EditingErrorResponseSchema,
  410: EditingErrorResponseSchema,
  413: EditingErrorResponseSchema,
  429: EditingErrorResponseSchema,
  503: EditingErrorResponseSchema,
};
const actionBody = z.strictObject({});

/** Authenticated Office session resources contributed by Machine to the web protocol slot. */
export function createWebFileEditingRoutes(
  deps: WebMachineRouteDependencies,
  facade: MachineFileEditingFacade = machineFileEditingFacade,
) {
  const app = new Elysia({ name: "machine-file-editing" }).use(deps.authGuardPlugin);
  app.get(
    "/environments/:id/file-editing-capabilities",
    ({ store, params }) => editingResponse(() => facade.capabilities(editingActor(store), params.id)),
    {
      sessionAuth: true,
      params: EditingSessionParamsSchema,
      response: { 200: ok(EditingCapabilitiesSchema), ...errors },
      detail: { tags: ["Files"], summary: "查询环境在线编辑能力" },
    },
  );
  app.post(
    "/environments/:id/office-edit-sessions",
    ({ store, params, body }) =>
      editingResponse(() => facade.open(editingActor(store), params.id, body.path, body.lang)),
    {
      sessionAuth: true,
      params: EditingSessionParamsSchema,
      body: OpenEditingSessionSchema,
      response: { 200: ok(EditingSessionSchema), ...errors },
      detail: { tags: ["Files"], summary: "创建 Office 编辑会话" },
    },
  );
  app.get(
    "/office-edit-sessions/:id",
    ({ store, params }) => editingResponse(() => facade.status(editingActor(store), params.id)),
    {
      sessionAuth: true,
      params: EditingSessionParamsSchema,
      response: { 200: ok(EditingSessionStatusSchema), ...errors },
      detail: { tags: ["Files"], summary: "查询编辑保存状态" },
    },
  );
  app.post(
    "/office-edit-sessions/:id/save",
    ({ store, params, headers }) =>
      editingResponse(() => facade.save(editingActor(store), params.id, headers["x-file-op-id"])),
    {
      sessionAuth: true,
      params: EditingSessionParamsSchema,
      body: actionBody,
      headers: z.object({ "x-file-op-id": z.string().min(1).max(200) }),
      response: { 200: ok(z.object({ saveId: z.string() })), ...errors },
      detail: { tags: ["Files"], summary: "保存 Office 到工作区" },
    },
  );
  app.post(
    "/office-edit-sessions/:id/overwrite",
    ({ store, params }) => editingResponse(() => facade.overwrite(editingActor(store), params.id)),
    {
      sessionAuth: true,
      params: EditingSessionParamsSchema,
      body: actionBody,
      response: { 200: ok(EditingSessionStatusSchema), ...errors },
      detail: { tags: ["Files"], summary: "确认覆盖本次冲突结果" },
    },
  );
  app.post(
    "/office-edit-sessions/:id/close",
    ({ store, params }) =>
      editingResponse(async () => {
        await facade.close(editingActor(store), params.id);
        return { ok: true as const };
      }),
    {
      sessionAuth: true,
      params: EditingSessionParamsSchema,
      body: actionBody,
      response: { 200: ok(z.object({ ok: z.literal(true) })), ...errors },
      detail: { tags: ["Files"], summary: "结束编辑并等待关闭保存" },
    },
  );
  app.delete(
    "/office-edit-sessions/:id",
    ({ store, params }) =>
      editingResponse(async () => {
        await facade.discard(editingActor(store), params.id);
        return { ok: true as const };
      }),
    {
      sessionAuth: true,
      params: EditingSessionParamsSchema,
      response: { 200: ok(z.object({ ok: z.literal(true) })), ...errors },
      detail: { tags: ["Files"], summary: "放弃编辑并撤销写回权" },
    },
  );
  return app;
}
