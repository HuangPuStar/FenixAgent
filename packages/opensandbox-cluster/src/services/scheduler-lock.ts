import type { Database } from "bun:sqlite";

export class SchedulerLock {
  constructor(private readonly sqlite: Database) {}

  run<T>(operation: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}
