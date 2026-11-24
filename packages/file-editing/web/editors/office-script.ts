import { EDITING_DEFAULTS } from "../../contracts";
/** Minimal provider interface; its configuration is intentionally opaque to the host. */
export interface OfficeEditorInstance {
  destroyEditor(): void;
}
/** Browser API supplied by the configured document service. */
export interface OfficeBrowserApi {
  DocEditor: new (id: string, config: Record<string, unknown>) => OfficeEditorInstance;
}
const scripts = new Map<string, Promise<OfficeBrowserApi>>();
/** Reuses concurrent loads, removes failed elements and permits an explicit retry. */
export function loadOfficeScript(url: string): Promise<OfficeBrowserApi> {
  const cached = scripts.get(url);
  if (cached) return cached;
  const script = document.createElement("script");
  let finish!: (api: OfficeBrowserApi) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<OfficeBrowserApi>((resolve, failed) => {
    finish = resolve;
    reject = failed;
  });
  scripts.set(url, promise);
  const fail = () => {
    clearTimeout(timer);
    script.remove();
    scripts.delete(url);
    reject(new Error("Office script initialization failed"));
  };
  const timer = setTimeout(fail, EDITING_DEFAULTS.timeoutMs);
  script.src = url;
  script.async = true;
  script.onerror = fail;
  script.onload = () => {
    clearTimeout(timer);
    const api = (window as unknown as { DocsAPI?: OfficeBrowserApi }).DocsAPI;
    if (api?.DocEditor) finish(api);
    else fail();
  };
  document.head.appendChild(script);
  return promise;
}
