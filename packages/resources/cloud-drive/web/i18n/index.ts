// web/i18n/index.ts
// 云盘命名空间的文案资源出口（键的最终所在地 = 包的 owner）。
//
// 宿主注册方式（apps/web/src/i18n/index.ts）：从子路径 `@fenix/resource-cloud-drive/web/i18n`
// 导入本模块，把 `cloudDriveResources.en/zh` 登记到 `CLOUD_DRIVE_NS`。走子路径而不是 `./web` 根入口：
// 宿主 i18n 在应用启动时求值，从根入口导入会把页面（表格、对话框、上传 hook）拉进首屏 bundle。
//
// JSON 路径是包自身的契约（`web/__tests__/cloud-drive-i18n.test.ts` 钉住 en/zh 键集一致），
// 宿主不得按相对路径取。

import en from "./locales/en/cloudDrive.json";
import zh from "./locales/zh/cloudDrive.json";

export { CLOUD_DRIVE_NS } from "./namespace";

/**
 * 云盘的 en / zh 文案资源；两份键结构完全一致（缺键会让界面回退显示 key，
 * 由 `web/__tests__/cloud-drive-i18n.test.ts` 守护）。
 */
export const cloudDriveResources = { en, zh } as const;

export type CloudDriveResources = typeof cloudDriveResources;
