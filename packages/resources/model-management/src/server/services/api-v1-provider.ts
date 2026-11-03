import { type ActorContext, AppError } from "@fenix/platform-sdk";
import type {
  AuthorizedProvider,
  AuthorizedProviderDetail,
  AuthorizedProviderListItem,
} from "../facades/provider-facade";
import type { ApiProviderUpdateBody } from "../schemas/api-model.schema";

/** Resolve only the authenticated actor supplied by the host guard. */
export function apiProviderActor(store: { actor?: ActorContext | null }): ActorContext {
  if (!store.actor) throw new AppError("请求缺少组织上下文", "UNAUTHORIZED", 401);
  return store.actor;
}

/** Independent credential-free v1 provider projection. */
function providerBase(row: AuthorizedProvider) {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName ?? null,
    kind: row.kind,
    gatewayType: row.gatewayType ?? null,
    protocol: row.protocol,
    baseUrl: row.baseUrl ?? null,
    hasApiKey: Boolean(row.apiKey),
    scope: row.scope,
    access: row.access,
  };
}

/** Collection projection includes the authorized model count. */
export function apiProviderListItem(row: AuthorizedProviderListItem) {
  return { ...providerBase(row), modelCount: row.modelCount };
}

/** Details intentionally do not embed all models. */
export function apiProviderDetail(row: AuthorizedProviderDetail) {
  return { ...providerBase(row), extraOptions: row.extraOptions ?? null };
}

/** Copy only explicitly supplied writable fields across the protocol boundary. */
export function apiProviderWrite(body: ApiProviderUpdateBody) {
  return {
    ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
    ...(body.protocol === undefined ? {} : { protocol: body.protocol }),
    ...(body.baseUrl === undefined ? {} : { baseUrl: body.baseUrl }),
    ...(body.apiKey === undefined ? {} : { apiKey: body.apiKey }),
    ...(body.extraOptions === undefined ? {} : { extraOptions: body.extraOptions }),
  };
}

/** Model identifiers distinguish database identity from upstream model code. */
export function apiModelDetail(row: AuthorizedProviderDetail["models"][number]) {
  const options = row.options && typeof row.options === "object" && !Array.isArray(row.options) ? row.options : null;
  return {
    id: row.id,
    providerId: row.providerId,
    modelId: row.modelId,
    displayName: row.displayName ?? null,
    modalities: row.modalities ?? null,
    limitConfig: row.limitConfig ?? null,
    cost: row.cost ?? null,
    options,
  };
}
