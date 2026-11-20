import { EDITING_DEFAULTS, EditingError } from "../../contracts";

interface SyncWaiter {
  resolve(): void;
  reject(error: unknown): void;
}
/** Tracks provider cache synchronization independently from workspace dirty state. */
export class OfficeSyncBarrier {
  private ready = false;
  private synchronized = true;
  private disposed = false;
  private readonly waiters = new Set<SyncWaiter>();
  /** Initial content can be used only after the provider reports document readiness. */
  setReady() {
    if (!this.disposed) {
      this.ready = true;
      this.release();
    }
  }
  /** Provider false acknowledges its cache only; it never acknowledges a workspace upload. */
  setSynchronized(value: boolean) {
    if (!this.disposed) {
      this.synchronized = value;
      this.release();
    }
  }
  private release() {
    if (this.ready && this.synchronized) for (const waiter of [...this.waiters]) waiter.resolve();
  }
  /** Waits for a known synchronized generation, with bounded lifetime and explicit cancellation. */
  wait(signal: AbortSignal): Promise<boolean> {
    if (this.disposed) return Promise.reject(new EditingError("unavailable", "officeNotReady"));
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.ready && this.synchronized) return Promise.resolve(true);
    return new Promise<boolean>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        this.waiters.delete(waiter);
      };
      const waiter: SyncWaiter = {
        resolve: () => {
          cleanup();
          resolve(true);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      const aborted = () => waiter.reject(signal.reason);
      const timer = setTimeout(
        () => waiter.reject(new EditingError("unavailable", "officeSyncTimedOut")),
        EDITING_DEFAULTS.timeoutMs,
      );
      this.waiters.add(waiter);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }
  /** Provider errors reject current saves while preserving the mounted document for recovery. */
  fail(error: unknown) {
    this.synchronized = false;
    for (const waiter of [...this.waiters]) waiter.reject(error);
  }
  /** Rejects pending saves before the corresponding iframe is destroyed. */
  dispose() {
    this.disposed = true;
    this.fail(new EditingError("unavailable", "officeNotReady"));
  }
}
