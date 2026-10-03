import { describe, it, expect } from "vitest";
import { sanitizeConnectionForResponse } from "@/lib/providerNormalization";

describe("sanitizeConnectionForResponse", () => {
  it("strips top-level credentials and nested sensitive metadata", () => {
    const raw = {
      id: "conn-123",
      provider: "kiro",
      name: "Work Account",
      apiKey: "sk-live-12345",
      accessToken: "access-token-12345",
      refreshToken: "refresh-token-12345",
      idToken: "id-token-12345",
      providerSpecificData: {
        prefix: "kiro-work",
        baseUrl: "https://api.example.com",
        clientSecret: "very-long-secret-key",
        idToken: "nested-id-token",
        zaiAccessToken: "nested-zai-token",
        zcodeJwtToken: "nested-jwt-token",
        proxyPoolId: "pool-abc",
        nodeName: "Custom Node",
        region: "us-east-1",
      },
    };

    const sanitized = sanitizeConnectionForResponse(raw);

    // Top-level secrets removed
    expect(sanitized.apiKey).toBeUndefined();
    expect(sanitized.accessToken).toBeUndefined();
    expect(sanitized.refreshToken).toBeUndefined();
    expect(sanitized.idToken).toBeUndefined();

    // Nested non-sensitive metadata preserved
    expect(sanitized.providerSpecificData).toEqual({
      prefix: "kiro-work",
      baseUrl: "https://api.example.com",
      proxyPoolId: "pool-abc",
      nodeName: "Custom Node",
      region: "us-east-1",
    });

    // Nested secrets stripped
    expect(sanitized.providerSpecificData.clientSecret).toBeUndefined();
    expect(sanitized.providerSpecificData.idToken).toBeUndefined();
    expect(sanitized.providerSpecificData.zaiAccessToken).toBeUndefined();
    expect(sanitized.providerSpecificData.zcodeJwtToken).toBeUndefined();
  });

  it("handles null or non-object connection gracefully", () => {
    expect(sanitizeConnectionForResponse(null)).toBeNull();
    expect(sanitizeConnectionForResponse(undefined)).toBeUndefined();
  });
});
