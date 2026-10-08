import { AI_PROVIDERS } from "@/shared/constants/providers";
import { sanitizeConnectionForResponse } from "@/lib/providerNormalization";

export function usesAwsCredentialForm(provider) {
  return AI_PROVIDERS[provider]?.credentialForm === "aws";
}

export function toProviderConnectionResponse(connection) {
  return sanitizeConnectionForResponse(connection);
}
