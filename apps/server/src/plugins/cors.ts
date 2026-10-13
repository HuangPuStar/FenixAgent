import cors from "@elysiajs/cors";
import Elysia from "elysia";

/** Builds the CORS origin option from a comma-separated environment value. */
export function buildCorsOrigin(value = process.env.RCS_CORS_ORIGIN): string | string[] {
  const origins = (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length === 0) return "*";
  if (origins.length === 1) return origins[0];
  return origins;
}

export const corsPlugin = new Elysia({ name: "cors" }).use(
  cors({
    origin: buildCorsOrigin(),
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);
