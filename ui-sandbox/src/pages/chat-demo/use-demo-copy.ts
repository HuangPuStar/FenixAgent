import demoCopy from "./demo-copy.json";

type DemoCopyValues = Record<string, string | number>;

function translate(key: string, values?: DemoCopyValues): string {
  const resolved = key.split(".").reduce<unknown>((value, part) => {
    if (!value || typeof value !== "object") return null;
    return (value as Record<string, unknown>)[part];
  }, demoCopy);
  if (typeof resolved !== "string") return key;
  if (!values) return resolved;
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
    resolved,
  );
}

/** Small literal-copy adapter for this unauthenticated design sandbox. */
export function useDemoTranslation() {
  return { t: translate };
}
