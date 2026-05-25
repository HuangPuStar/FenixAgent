import cors from "@elysiajs/cors";
import Elysia from "elysia";

export const corsPlugin = new Elysia({ name: "cors" }).use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);
