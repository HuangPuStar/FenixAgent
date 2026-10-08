import { request, unwrap } from "@fenix/web-runtime/api/request";
import { z } from "zod/v4";

const modulesSchema = z.object({ modules: z.array(z.string()), web: z.array(z.string()) });

/** 宿主只读能力端点；边界校验失败与网络失败走同一降级路径。 */
export async function getSystemModules() {
  return modulesSchema.parse(await unwrap(request<unknown>("/web/system/modules", { timeout: 10_000 })));
}
