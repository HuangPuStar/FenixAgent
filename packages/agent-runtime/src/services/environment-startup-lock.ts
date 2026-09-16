type StartupOperation<T> = () => Promise<T>;

type StartupResult<T> = {
  value: T;
  joined: boolean;
};

/**
 * 协调同一环境的启动请求。
 *
 * 启动过程包含远程节点准备和 ACP 进程拉起，运行时 registry 只有在整个过程
 * 完成后才会写入，因此不能只依赖启动前的实例查询来防止并发重复启动。
 */
export class EnvironmentStartupLock {
  // TODO: 多实例部署时改为数据库租约或分布式锁，避免不同 Fenix 进程并发启动同一环境。
  private readonly inFlight = new Map<string, Promise<unknown>>();

  async run<T>(environmentId: string, operation: StartupOperation<T>): Promise<StartupResult<T>> {
    const existing = this.inFlight.get(environmentId);
    if (existing) {
      return { value: (await existing) as T, joined: true };
    }

    const promise = operation();
    this.inFlight.set(environmentId, promise);
    try {
      return { value: await promise, joined: false };
    } finally {
      if (this.inFlight.get(environmentId) === promise) {
        this.inFlight.delete(environmentId);
      }
    }
  }
}
