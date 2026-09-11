export * from "./assembly/bootstrap";
export * from "./assembly/module-manifest";
export * from "./assembly/module-registry";
export * from "./assembly/profile";
export * from "./env-loader";
export * from "./resource/scoped-resource";
export * from "./services/authorized-resource-facade";
export * from "./services/authorized-resource-query";

/** 资源默认可见范围；public 仅对已认证主体生效。 */
export type ResourceVisibility = "private" | "public";
export type ResourceAction = "read" | "create" | "update" | "delete" | "use";
export type OwnershipMode = "organization" | "organization-personal" | "personal";
export interface ResourceDefinition {
  readonly type: string;
  readonly ownershipMode: OwnershipMode;
  readonly actions: readonly ResourceAction[];
  readonly memberDefaultActions: readonly Extract<ResourceAction, "read" | "use">[];
}
export interface ResourceScope {
  readonly organizationId?: string;
  readonly ownerUserId?: string;
  readonly visibility: ResourceVisibility;
}
export interface ResourceAccess {
  readonly actions: readonly ResourceAction[];
}
export type ResourceRecord<TData, TScope extends ResourceScope = ResourceScope> = TData & {
  readonly scope: TScope;
  readonly access: ResourceAccess;
};
export interface ResourceScopeStore<TScope extends ResourceScope = ResourceScope> {
  initialize(input: { resourceType: string; resourceId: string; scope: TScope }): Promise<void>;
  getMany(input: { resourceType: string; resourceIds: readonly string[] }): Promise<Map<string, TScope>>;
  update(input: { resourceType: string; resourceId: string; scope: TScope }): Promise<void>;
  remove(input: { resourceType: string; resourceId: string }): Promise<void>;
}
export interface ActorContext {
  readonly kind: "user";
  readonly userId: string;
  readonly systemRole?: "super-admin";
  readonly activeOrganizationId?: string;
  readonly memberships: readonly { readonly organizationId: string; readonly role: "owner" | "admin" | "member" }[];
}
export type ResourceQueryConstraint = Readonly<{ resourceType: string; action: "read" | "use" }>;
export interface AuthorizationInput {
  readonly actor: ActorContext;
  readonly action: ResourceAction;
  readonly resource: ResourceDefinition;
  readonly resourceId: string;
}
export interface AccessControlModule {
  readonly id: string;
  createActorContext(input: { actorId: string }): Promise<ActorContext>;
  initializeResourceAccess(input: {
    actor: ActorContext;
    resource: ResourceDefinition;
    resourceId: string;
  }): Promise<void>;
  authorize(input: AuthorizationInput): Promise<void>;
  createListConstraint(input: {
    actor: ActorContext;
    resource: ResourceDefinition;
    action: "read" | "use";
  }): ResourceQueryConstraint;
  resolveAccess(input: {
    actor: ActorContext;
    resource: ResourceDefinition;
    resourceId: string;
  }): Promise<ResourceAccess>;
}
export interface ResourceScopeStoreBinding {
  bindResourceScopeStore(store: ResourceScopeStore): void;
}
