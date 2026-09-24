import { ApiError } from "@fenix/web-runtime/api/request";
import { useTranslation } from "react-i18next";
import { MODELS_NS } from "../../../i18n/namespace";

/**
 * 探测类失败（测试模型 / 获取模型列表）的展示文案。
 *
 * 后端的 `code` 是稳定协议、只用于分支；可读的诊断信息全部在信封顶层的 `data` 里（`unwrap` 把它搬到
 * `ApiError.data`）：上游 HTTP 状态、上游响应正文摘要（服务端已截断到 200 字符）、以及"超时 / 请求
 * 失败"的区分。此前 `data` 没有任何消费方，于是用户只看到 `MODEL_TEST_MESSAGE_HTTP_ERROR` 这类内部
 * 字面量——这正是"模型的测试接口有问题"的用户视角。
 *
 * 文案复用本包既有的 `testDialog.errors.*` 字典，不新造一套；`data` 里不存在凭据字段，这里也不回显
 * apiKey 原文或解析后的密钥值。
 */

/** `data` 中与展示相关的字段；形状不认识时按"没有诊断信息"处理，不猜。 */
interface ProviderTestErrorData {
  protocol?: string;
  status?: number;
  detail?: string;
  reason?: string;
  hint?: string;
}

function readErrorData(value: unknown): ProviderTestErrorData {
  if (typeof value !== "object" || value === null) return {};
  const source = value as Record<string, unknown>;
  return {
    protocol: typeof source.protocol === "string" ? source.protocol : undefined,
    status: typeof source.status === "number" ? source.status : undefined,
    detail: typeof source.detail === "string" ? source.detail : undefined,
    reason: typeof source.reason === "string" ? source.reason : undefined,
    hint: typeof source.hint === "string" ? source.hint : undefined,
  };
}

/**
 * 拼接多行原因：空段直接丢弃，避免出现悬空的"错误信息："。
 *
 * 段间用换行而不是空格：tooltip 里是真换行，HTML 文本节点里折叠成空格，两种落点都读得通。
 */
function joinParts(parts: (string | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join("\n");
}

/** 探测失败的展示文案：按错误码选文案，按 `data` 补上游状态、响应正文摘要与失败原因。 */
export function useProviderTestErrorText() {
  const { t } = useTranslation(MODELS_NS);
  return (error: unknown): string => {
    if (!(error instanceof ApiError)) {
      // 非信封异常（本地抛错、网络层异常）没有可映射的稳定码，同样只给通用文案（§9.3）。
      return t("unknownError");
    }

    const data = readErrorData(error.data);
    // 协议名走枚举分支而不是 `t(\`protocolOptions.${x}\`)`：字典键保持静态字面量，守卫才扫得到。
    const protocol = data.protocol === "anthropic" ? t("protocolOptions.anthropic") : t("protocolOptions.openai");
    const detail = data.detail ? `${t("testDialog.errors.detailPrefix")}${data.detail}` : undefined;

    switch (error.code) {
      case "PROVIDER_TEST_LIST_HTTP_ERROR":
        return joinParts([
          t("testDialog.errors.providerListHttp", { protocol, status: data.status ?? "?" }),
          detail,
          // Anthropic 的 /models 在部分部署上不可用，但 /messages 可用：提示改用"测试模型"。
          data.hint === "configure_model_then_test_model" ? t("testDialog.errors.configureModelThenTest") : undefined,
        ]);
      case "PROVIDER_TEST_LIST_RESPONSE_INVALID":
        return data.reason === "missing_model_id"
          ? t("testDialog.errors.providerListMissingModelId", { protocol })
          : t("testDialog.errors.providerListMissingData", { protocol });
      case "MODEL_TEST_MESSAGE_HTTP_ERROR":
        return joinParts([t("testDialog.errors.modelMessageHttp", { protocol, status: data.status ?? "?" }), detail]);
      // 2xx 但响应里没有可展示文本（或正文不是 JSON）：端点通了，却没有证据表明这个模型能正常回话，
      // 因此不给"通过"。上游正文摘要（`detail`）在这类情形里最有诊断价值，一并拼上。
      case "MODEL_TEST_MESSAGE_RESPONSE_INVALID":
        return joinParts([t("testDialog.errors.modelMessageEmpty", { protocol }), detail]);
      case "CONFIG_TEST_REQUEST_FAILED":
        return joinParts([
          data.reason === "timeout" ? t("testDialog.errors.requestTimeout") : t("testDialog.errors.requestFailed"),
          detail,
        ]);
      // 凭据引用解析不出来：探测还没发出请求就失败，重试无用，用户需要去补环境变量。
      case "CONFIG_TEST_CREDENTIAL_UNRESOLVED":
        return t("testDialog.errors.credentialUnresolved");
      default:
        // 非探测类失败（NOT_FOUND / FORBIDDEN …）：没有对应的稳定码文案，按 §9.3 用安全通用文案，
        // 不显示 `ApiError.message`（那是后端错误信封原文）。诊断信息由调用方的 `console.error` 承载。
        return t("unknownError");
    }
  };
}
