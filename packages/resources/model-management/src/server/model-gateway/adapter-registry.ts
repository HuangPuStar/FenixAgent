import type { ModelGatewayAdapter } from "@fenix/model-gateway-sdk";

/** 模型网关 Adapter 注册表，隔离 gatewayType 与具体实现的绑定。 */
export interface ModelGatewayAdapterRegistry {
  get(type: string): ModelGatewayAdapter;
}

export function createModelGatewayAdapterRegistry(
  adapters: readonly ModelGatewayAdapter[],
): ModelGatewayAdapterRegistry {
  const byType = new Map(adapters.map((adapter) => [adapter.type, adapter]));
  return {
    get(type: string): ModelGatewayAdapter {
      const adapter = byType.get(type);
      if (!adapter) throw new Error(`unsupported model gateway type: ${type}`);
      return adapter;
    },
  };
}
