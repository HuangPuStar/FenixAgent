// src/services/observer/index.ts
// Observer Service barrel 导出（docs/arch/21-observability-observer-service.md）。

export type { ObserverServiceDeps } from "./observer-service";
export {
  ObserverKindNotFoundError,
  ObserverService,
  observerService,
  resetObserverServiceDeps,
  setObserverServiceDeps,
} from "./observer-service";
export { acpLinkProvider, collectAcpLink } from "./providers/acp-link";
export { buildRelationTree } from "./relation-tree";
export type {
  AgentNodeView,
  ChatClientSnapshot,
  InstanceNodeView,
  IntegritySummary,
  KindProvider,
  LeafView,
  MachineTreeLeaf,
  MachineTreeView,
  Observation,
  ObservationNames,
  ObserverContext,
  ObserverLinkSource,
  OrgNodeView,
  RelationTreeView,
  UserNodeView,
} from "./types";
export { OBSERVER_LINK_SOURCES } from "./types";
