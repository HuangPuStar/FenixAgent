import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_PATH = join(homedir(), ".config", "opencode", "opencode.json");
const CONFIG_DIR = join(homedir(), ".config", "opencode");
const LOCK_TIMEOUT_MS = 5000;

// Promise 互斥锁：防止并发写入
let writeLock: Promise<void> = Promise.resolve();
function acquireWriteLock(): Promise<() => void> {
  let release: () => void;
  const prevLock = writeLock;
  writeLock = new Promise<void>((resolve) => { release = resolve; });
  // 超时自动释放
  const timer = setTimeout(() => release!(), LOCK_TIMEOUT_MS);
  return prevLock.then(() => {
    clearTimeout(timer);
    return release!;
  });
}

async function ensureConfigDir(): Promise<void> {
  if (!existsSync(CONFIG_DIR)) await mkdir(CONFIG_DIR, { recursive: true });
}

function deepMerge(target: unknown, source: unknown): unknown {
  if (typeof target !== "object" || target === null) return source;
  if (typeof source !== "object" || source === null) return source;
  const result = { ...(target as Record<string, unknown>) };
  for (const key of Object.keys(source as Record<string, unknown>)) {
    const srcVal = (source as Record<string, unknown>)[key];
    const tgtVal = (result as Record<string, unknown>)[key];
    (result as Record<string, unknown>)[key] =
      typeof srcVal === "object" && srcVal !== null && !Array.isArray(srcVal)
        ? deepMerge(tgtVal, srcVal)
        : srcVal;
  }
  return result;
}

export async function getConfig(): Promise<Record<string, unknown>> {
  if (!existsSync(CONFIG_PATH)) return {};
  const raw = await readFile(CONFIG_PATH, "utf-8");
  return JSON.parse(raw);
}

export async function getSection<T = unknown>(section: string): Promise<T | undefined> {
  const config = await getConfig();
  return config[section] as T | undefined;
}

export async function setSection(section: string, data: unknown): Promise<void> {
  const release = await acquireWriteLock();
  try {
    const config = await getConfig();
    config[section] = deepMerge(config[section] ?? {}, data);
    await ensureConfigDir();
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
  } finally {
    release();
  }
}

export async function replaceSection(section: string, data: unknown): Promise<void> {
  const release = await acquireWriteLock();
  try {
    const config = await getConfig();
    config[section] = data;
    await ensureConfigDir();
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
  } finally {
    release();
  }
}

export async function modifySection<T>(
  section: string,
  modifier: (current: T | undefined) => T,
): Promise<T> {
  const release = await acquireWriteLock();
  try {
    const config = await getConfig();
    const current = config[section] as T | undefined;
    const modified = modifier(current);
    config[section] = modified;
    await ensureConfigDir();
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
    return modified;
  } finally {
    release();
  }
}

export async function deleteSection(section: string): Promise<boolean> {
  const release = await acquireWriteLock();
  try {
    const config = await getConfig();
    if (!(section in config)) return false;
    delete config[section];
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
    return true;
  } finally {
    release();
  }
}

export async function setTopLevelField(field: string, value: unknown): Promise<void> {
  const release = await acquireWriteLock();
  try {
    const config = await getConfig();
    config[field] = value;
    await ensureConfigDir();
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
  } finally {
    release();
  }
}
