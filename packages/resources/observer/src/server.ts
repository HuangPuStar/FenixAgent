/** Observer 资源包的服务端公开入口。 */

export { default as apiSystemLogsRoutes } from "./server/routes/api/system-logs";
export { default as apiSystemObserverRoutes } from "./server/routes/api/system-observer";
export { default as apiSystemPeopleTreeRoutes } from "./server/routes/api/system-people-tree";
export type { ChatClientSnapshot, ObserverServiceDeps } from "./server/services/observer";
