import { strict as assert } from "node:assert";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { MODELS_NS, modelManagementResources } from "../../i18n";
import { ModelGatewayModelsPanel } from "../../pages/admin/model-gateway-models-panel";

type Scenario = "missing" | "error" | "configured";
const scenario = process.argv[2] as Scenario;
assert.ok(["missing", "error", "configured"].includes(scenario));

const instance = createInstance();
await instance.use(initReactI18next).init({
  lng: "zh",
  ns: [MODELS_NS],
  resources: { zh: { [MODELS_NS]: modelManagementResources.zh } },
});

const html = renderToStaticMarkup(
  createElement(
    I18nextProvider,
    { i18n: instance },
    createElement(ModelGatewayModelsPanel, {
      status: null,
      config: {
        provider: null,
        adminUiUrl: scenario === "configured" ? "https://gateway.example.test/ui/" : null,
        defaultBudget: { maxBudgetUsd: null, duration: null },
      },
      configError: scenario === "error" ? new Error("service unavailable") : undefined,
      configLoading: false,
      onRetryConfig: () => {},
      checking: false,
      syncing: false,
      busy: false,
      modelSearch: "",
      modelFilter: "all",
      onModelSearchChange: () => {},
      onModelFilterChange: () => {},
      onCheck: () => {},
      onSync: () => {},
    }),
  ),
);

if (scenario === "missing") {
  assert.ok(html.includes("RCS_MODEL_GATEWAY_ADMIN_UI_URL"));
  assert.ok(html.includes('role="alert"'));
  assert.ok(!html.includes('target="_blank"'));
} else if (scenario === "error") {
  assert.ok(html.includes("读取模型网关配置失败"));
  assert.ok(html.includes("重试"));
  assert.ok(!html.includes("service unavailable"));
} else {
  assert.ok(html.includes('href="https://gateway.example.test/ui/"'));
  assert.ok(html.includes('target="_blank"'));
  assert.ok(!html.includes("RCS_MODEL_GATEWAY_ADMIN_UI_URL"));
}
