// Global type declarations

declare module "@server/index" {
  // Eden Treaty requires the Elysia App type from the backend.
  // The actual type is inferred at build time; this declaration
  // allows the frontend to import it without TS2307 errors.
  import type { Elysia } from "elysia";

  type App = ReturnType<typeof Elysia>;

  export { type App };
}
