import { t } from "elysia";
/** Shared raw Cluster lifecycle error response. */
export const managedErrorSchema = t.Object({ error: t.Object({ code: t.String(), message: t.String() }) });
/** Four resource values use platform units; count-mode budgets are null. */
export const resourceViewSchema = t.Object({
  cpu: t.Nullable(t.Number()),
  memoryMb: t.Nullable(t.Number()),
  diskGb: t.Nullable(t.Number()),
  gpuCount: t.Nullable(t.Number()),
});
/** Managed allocation DTO deliberately excludes secrets and native request bodies. */
export const managedSandboxSchema = t.Object({
  sandbox_id: t.String(),
  pool_id: t.String(),
  server_id: t.String(),
  allocation_mode: t.String(),
  state: t.String(),
  resources: resourceViewSchema,
  expires_at: t.Nullable(t.Number()),
  provider_sandbox_id: t.Nullable(t.String()),
  proxy_url: t.String(),
});
/** Node accounting includes unresolved and pending-release usage within allocated totals. */
export const serverResourcesSchema = t.Object({
  server_id: t.String(),
  capacity: resourceViewSchema,
  allocated: resourceViewSchema,
  pending: resourceViewSchema,
  remaining: t.Record(t.String(), t.Nullable(t.Number())),
});
/** Authentication is checked by the existing service-key hook. */
export const managedHeaders = t.Object({ authorization: t.Optional(t.String()) }, { additionalProperties: true });
/** Common documented lifecycle and validation errors. */
export const managedErrorResponses = {
  400: managedErrorSchema,
  401: managedErrorSchema,
  403: managedErrorSchema,
  404: managedErrorSchema,
  409: managedErrorSchema,
  410: managedErrorSchema,
  500: managedErrorSchema,
  502: managedErrorSchema,
  503: managedErrorSchema,
};
