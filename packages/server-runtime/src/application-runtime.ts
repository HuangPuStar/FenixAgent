import type { AnyElysia } from "elysia";
import type { AnyServerModule, ModuleDisposer, ModuleStartContext } from "./server-module";

/** ApplicationRuntime 的可观察生命周期状态。 */
export type ApplicationRuntimeState = "created" | "starting" | "listening" | "stopping" | "stopped" | "failed";

/** 模块释放失败及其所有者。 */
export interface ModuleDisposalFailure {
  readonly moduleName: string;
  readonly error: unknown;
}

/** 应用启动失败，并保留首个错误及附加释放错误。 */
export class ApplicationStartError extends Error {
  readonly phase: "module" | "listen";
  readonly moduleName?: string;
  readonly unwindFailures: readonly ModuleDisposalFailure[];

  constructor(options: {
    phase: "module" | "listen";
    moduleName?: string;
    cause: unknown;
    unwindFailures: readonly ModuleDisposalFailure[];
  }) {
    const subject = options.moduleName ? `module '${options.moduleName}'` : "Elysia listener";
    super(`Application startup failed in ${subject}`, { cause: options.cause });
    this.name = "ApplicationStartError";
    this.phase = options.phase;
    this.moduleName = options.moduleName;
    this.unwindFailures = options.unwindFailures;
  }
}

/** 应用停止完成后汇总的资源释放错误。 */
export class ApplicationStopError extends AggregateError {
  readonly failures: readonly ModuleDisposalFailure[];

  constructor(failures: readonly ModuleDisposalFailure[]) {
    super(
      failures.map((failure) => failure.error),
      `Application stopped with ${failures.length} disposal failure(s)`,
    );
    this.name = "ApplicationStopError";
    this.failures = failures;
  }
}

type StartedModule = {
  readonly name: string;
  readonly dispose: ModuleDisposer;
};

/** 已构造应用的启动、监听和资源释放句柄。 */
export class ApplicationRuntime<
  TApp extends AnyElysia,
  TModules extends readonly AnyServerModule[] = readonly AnyServerModule[],
> {
  readonly app: TApp;
  readonly profileName: string;

  private currentState: ApplicationRuntimeState = "created";
  private readonly abortController = new AbortController();
  private readonly startedModules: StartedModule[] = [];
  private startPromise: Promise<this> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(
    app: TApp,
    profileName: string,
    private readonly modules: TModules,
  ) {
    this.app = app;
    this.profileName = profileName;
  }

  /** 返回当前运行状态的只读快照。 */
  get state(): ApplicationRuntimeState {
    return this.currentState;
  }

  /** 顺序启动模块，并在全部成功后监听端口。 */
  start(listenOptions: Parameters<TApp["listen"]>[0]): Promise<this> {
    if (this.currentState !== "created") {
      return Promise.reject(new Error(`Application cannot start from state '${this.currentState}'`));
    }

    this.currentState = "starting";
    this.startPromise = this.startInternal(listenOptions);
    return this.startPromise;
  }

  /** 停止接入并逆序释放所有成功启动模块。 */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;

    if (this.currentState === "starting") {
      this.stopPromise = this.stopWhileStarting();
      this.abortController.abort(new Error("Application stop requested"));
      return this.stopPromise;
    }
    if (this.currentState === "created" || this.currentState === "listening") {
      const stopApp = this.currentState === "listening";
      this.currentState = "stopping";
      this.stopPromise = Promise.resolve().then(() => this.stopInternal(stopApp));
      return this.stopPromise;
    }

    this.stopPromise = Promise.resolve();
    return this.stopPromise;
  }

  private async startInternal(listenOptions: Parameters<TApp["listen"]>[0]): Promise<this> {
    let moduleName: string | undefined;
    let phase: "module" | "listen" = "module";

    try {
      const context: ModuleStartContext = { signal: this.abortController.signal };
      for (const module of this.modules) {
        this.throwIfStartupAborted();
        moduleName = module.name;
        const disposer = await module.start?.(context);
        if (disposer) this.startedModules.push({ name: module.name, dispose: disposer });
        this.throwIfStartupAborted();
      }

      phase = "listen";
      moduleName = undefined;
      this.app.listen(listenOptions);
      this.currentState = "listening";
      return this;
    } catch (error) {
      this.abortController.abort(error);
      const unwindFailures: ModuleDisposalFailure[] = [];
      if (phase === "listen" && this.app.server) {
        try {
          await this.app.stop();
        } catch (stopError) {
          unwindFailures.push({ moduleName: "elysia", error: stopError });
        }
      }
      unwindFailures.push(...(await this.disposeStartedModules()));
      this.currentState = "failed";
      throw new ApplicationStartError({ phase, moduleName, cause: error, unwindFailures });
    }
  }

  private async stopWhileStarting(): Promise<void> {
    try {
      await this.startPromise;
    } catch {
      return;
    }

    if (this.currentState === "listening") {
      this.currentState = "stopping";
      await this.stopInternal(true);
    }
  }

  private async stopInternal(stopApp: boolean): Promise<void> {
    const failures: ModuleDisposalFailure[] = [];
    if (stopApp) {
      try {
        await this.app.stop();
      } catch (error) {
        failures.push({ moduleName: "elysia", error });
      }
    }
    this.abortController.abort(new Error("Application stop requested"));
    failures.push(...(await this.disposeStartedModules()));

    this.currentState = failures.length === 0 ? "stopped" : "failed";
    if (failures.length > 0) throw new ApplicationStopError(failures);
  }

  private async disposeStartedModules(): Promise<ModuleDisposalFailure[]> {
    const failures: ModuleDisposalFailure[] = [];
    while (this.startedModules.length > 0) {
      const module = this.startedModules.pop();
      if (!module) break;
      try {
        await module.dispose();
      } catch (error) {
        failures.push({ moduleName: module.name, error });
      }
    }
    return failures;
  }

  private throwIfStartupAborted(): void {
    if (!this.abortController.signal.aborted) return;
    const reason = this.abortController.signal.reason;
    throw reason instanceof Error ? reason : new Error("Application startup aborted");
  }
}
