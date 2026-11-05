import { createInstance } from "i18next";

const instance = createInstance();
void instance.init({
  lng: "zh-CN",
  fallbackLng: "zh-CN",
  initAsync: false,
  keySeparator: false,
  nsSeparator: false,
  resources: { "zh-CN": { translation: {} } },
  interpolation: { escapeValue: false },
});
/** Standalone console strings; independent of the main application's locale bootstrap. */
export function t(message: string, values?: Record<string, string | number>) {
  return instance.t(message, { defaultValue: message, ...values });
}
