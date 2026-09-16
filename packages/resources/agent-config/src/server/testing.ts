/**
 * AgentConfig route dependency override seam for integration tests.
 *
 * Production callers must use the concrete services; this entry exists only so
 * workspace-level tests can inject their existing ConfigPg stubs without
 * importing package internals.
 */
export {
  resetRouteConfigDepsForTesting,
  setRouteConfigDepsForTesting,
} from "./routes/config-route-deps";
