import Elysia from "elysia";
import { getBrandingConfig, resolveBrandLogoFile } from "../../services/branding";

const app = new Elysia({ name: "web-branding", prefix: "/branding" })
  .get("/", () => {
    const branding = getBrandingConfig();
    return {
      success: true as const,
      data: {
        brandName: branding.brandName,
        logoUrl: branding.logoUrl,
      },
    };
  })
  .get("/logo", ({ set }) => {
    const logoFile = resolveBrandLogoFile();
    if (!logoFile) {
      return new Response(
        JSON.stringify({
          success: false as const,
          error: { code: "NOT_FOUND", message: "Brand logo not found" },
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        },
      );
    }

    const file = Bun.file(logoFile);
    set.headers["Cache-Control"] = "public, max-age=300";
    if (file.type) {
      set.headers["Content-Type"] = file.type;
    }
    return new Response(file);
  });

export default app;
