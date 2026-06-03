import type {
  CreateResourcePermissionGrantInput,
  DeleteResourcePermissionGrantInput,
  IResourcePermissionRepo,
  ResourcePermissionGrantRow,
  ResourcePermissionType,
} from "../../repositories/resource-permission";

type ResourcePermissionRepoOverrides = Partial<IResourcePermissionRepo>;

function missing(method: keyof IResourcePermissionRepo) {
  return () => {
    throw new Error(
      `resource-permission repo stub '${method}' not configured, call stubResourcePermissionRepo() in beforeEach`,
    );
  };
}

let overrides: ResourcePermissionRepoOverrides = {};

export const resourcePermissionRepoStub: IResourcePermissionRepo = {
  listByResource: (...args) => (overrides.listByResource ?? missing("listByResource"))(...args),
  createGrant: (...args) => (overrides.createGrant ?? missing("createGrant"))(...args),
  deleteGrant: (...args) => (overrides.deleteGrant ?? missing("deleteGrant"))(...args),
  listOwnedByOrganization: (...args) =>
    (overrides.listOwnedByOrganization ?? missing("listOwnedByOrganization"))(...args),
  listAccessibleForPrincipal: (...args) =>
    (overrides.listAccessibleForPrincipal ?? missing("listAccessibleForPrincipal"))(...args),
  canReadExternalResource: (...args) =>
    (overrides.canReadExternalResource ?? missing("canReadExternalResource"))(...args),
};

export function stubResourcePermissionRepo(stub: ResourcePermissionRepoOverrides) {
  overrides = { ...overrides, ...stub };
}

export function resetResourcePermissionRepoStub() {
  overrides = {};
}

export type {
  CreateResourcePermissionGrantInput,
  DeleteResourcePermissionGrantInput,
  ResourcePermissionGrantRow,
  ResourcePermissionType,
};
