// web/i18n/namespace.ts
// Observer 的 i18n 命名空间标识。
//
// 与 `./index` 分开声明：页面与组件只需要命名空间常量，不该因为 `useTranslation(OBSERVER_NS)`
// 就把两份字典（各 99 键）拉进模块图（字典由宿主统一注册，见 web/i18n/index.ts 的说明）。
// 同款先例：`@fenix/ui-components/i18n` 的命名空间常量 `UI_COMPONENTS_NS`，字典也从同出口导出。

/**
 * 命名空间归属本包（键的最终所在地 = 包的 owner，计划 §4），因此常量也由本包声明。
 *
 * 字面量与宿主 `apps/web/src/i18n/index.ts` 的 `NS.OBSERVER`、以及本包
 * `web/i18n/locales/{en,zh}/observer.json` 的文件名三处必须一致：宿主切换为经包入口注册后，这三处是
 * 同一个命名空间的三个视图（常量与文件名的一致性由 `web/__tests__/observer-i18n.test.ts` 断言）。
 */
export const OBSERVER_NS = "observer";
