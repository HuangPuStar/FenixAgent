/** Serialize content mutations by organization/name, taking multiple keys in stable order. */
const pending = new Map<string, Promise<void>>();
export async function withSkillMutation<T>(
  organizationId: string,
  names: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const keys = [...new Set(names)].sort().map((name) => JSON.stringify([organizationId, name]));
  const acquire = async (index: number): Promise<T> => {
    if (index === keys.length) return operation();
    const key = keys[index];
    const previous = pending.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.then(() => gate);
    pending.set(key, current);
    await previous;
    try {
      return await acquire(index + 1);
    } finally {
      release();
      if (pending.get(key) === current) pending.delete(key);
    }
  };
  return acquire(0);
}
