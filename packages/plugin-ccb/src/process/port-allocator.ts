import { createServer } from "node:net";

export const PORT_MIN = 8888;
export const PORT_MAX = 8999;

export interface PortAllocatorDependencies {
  probePort?: (port: number) => Promise<boolean>;
}

async function defaultProbePort(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();

    server.once("error", () => {
      resolve(false);
    });

    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * 为本地 acp-link 实例提供可复用的端口分配策略。
 */
export class PortAllocator {
  private readonly occupied = new Set<number>();
  private readonly probePort: (port: number) => Promise<boolean>;

  constructor(
    private readonly minPort = PORT_MIN,
    private readonly maxPort = PORT_MAX,
    dependencies: PortAllocatorDependencies = {},
  ) {
    this.probePort = dependencies.probePort ?? defaultProbePort;
  }

  async allocate(): Promise<number> {
    for (let port = this.minPort; port <= this.maxPort; port += 1) {
      if (this.occupied.has(port)) {
        continue;
      }
      if (!(await this.probePort(port))) {
        continue;
      }
      this.occupied.add(port);
      return port;
    }

    throw new Error(`No available port in range ${this.minPort}-${this.maxPort}`);
  }

  release(port: number): void {
    this.occupied.delete(port);
  }
}

export function createPortAllocator(dependencies: PortAllocatorDependencies = {}): PortAllocator {
  return new PortAllocator(PORT_MIN, PORT_MAX, dependencies);
}
