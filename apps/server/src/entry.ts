import { initializeTelemetry, shutdownTelemetry } from "./telemetry";

initializeTelemetry();
try {
  // 生产构建启用 splitting，使业务模块仍在 SDK 安装后才首次求值。
  await import("./main");
} catch (error) {
  await shutdownTelemetry();
  throw error;
}
