import Elysia from "elysia";
import { z } from "zod/v4";
import type { AssemblyModules } from "../../bootstrap/assembly-modules";

/** 宿主部署元数据与品牌配置同为公开只读面；不是用户权限清单，不依赖任何可选资源路由。 */
export function createSystemModulesApp(assembly: AssemblyModules) {
  const data = { modules: [...assembly.modules], web: [...assembly.web] };
  return new Elysia({ name: "web-system-modules" }).get(
    "/system/modules",
    ({ set }) => {
      set.headers["Cache-Control"] = "no-store";
      return { success: true as const, data };
    },
    {
      response: z.object({
        success: z.literal(true),
        data: z.object({ modules: z.array(z.string()), web: z.array(z.string()) }),
      }),
      detail: {
        tags: ["System"],
        summary: "获取当前装配的模块清单",
        description: "仅返回当前进程已装配的资源模块 ID 与 web 贡献 ID，不包含配置值，也不表达用户授权。",
      },
    },
  );
}
