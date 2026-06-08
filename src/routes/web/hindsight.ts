import Elysia from "elysia";
import { getHindsightConfig } from "../../services/hindsight";

const app = new Elysia({ name: "web-hindsight", prefix: "/hindsight" }).get("/status", () => {
  const config = getHindsightConfig();
  return {
    success: true as const,
    data: config ? { enabled: true, url: config.url } : { enabled: false },
  };
});

export default app;
