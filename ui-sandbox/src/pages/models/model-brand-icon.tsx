import AlibabaCloud from "@lobehub/icons/es/AlibabaCloud";
import Anthropic from "@lobehub/icons/es/Anthropic";
import DeepSeek from "@lobehub/icons/es/DeepSeek";
import OpenAI from "@lobehub/icons/es/OpenAI";
import { Boxes } from "lucide-react";

interface BrandIconProps {
  providerId: string;
  providerName: string;
  size?: number;
}

/** 使用项目已有的本地品牌图标，为服务商列表提供稳定的视觉识别。 */
export function ProviderBrandIcon({ providerId, providerName, size = 18 }: BrandIconProps) {
  const identity = `${providerId} ${providerName}`.toLowerCase();
  if (identity.includes("openai") || identity.includes("gpt")) return <OpenAI size={size} />;
  if (identity.includes("anthropic") || identity.includes("claude")) return <Anthropic size={size} />;
  if (
    identity.includes("bailian") ||
    identity.includes("alibaba") ||
    identity.includes("qwen") ||
    identity.includes("阿里")
  ) {
    return <AlibabaCloud size={size} />;
  }
  if (identity.includes("deepseek")) return <DeepSeek size={size} />;
  return <Boxes size={size} />;
}

/** 模型行使用模型自身的品牌图标；组件仅读取本地依赖，不产生网络请求。 */
export function SandboxModelIcon({ modelId, size = 17 }: { modelId: string; size?: number }) {
  return <ProviderBrandIcon providerId={modelId} providerName={modelId} size={size} />;
}
