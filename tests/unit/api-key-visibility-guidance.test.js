import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const oldGuidance = "This is the only time you will see this key. Store it securely.";
const guidance = "Store this key securely. You can view or copy it later from the API Keys list.";
const source = readFileSync(
  new URL("../../src/app/(dashboard)/dashboard/api-keys/ApiKeysPageClient.js", import.meta.url),
  "utf-8"
);

describe("API key visibility guidance source verification", () => {
  it("explains that created keys remain available in the API Keys list", () => {
    expect(source).toContain("API Key Created —");
    expect(source).toContain("Copy anytime — use the key list's Copy secret button whenever you need it again.");
    expect(source).not.toContain(oldGuidance);
  });

  it("retains the list's reveal and copy controls", () => {
    expect(source).toContain("visibleSecrets.has(secretModal.secret) ? secretModal.secret");
    expect(source).toContain("onClick={() => toggleSecretVisibility(secretModal.secret)}");
    expect(source).toContain("onClick={() => copySecret(secretModal.secret, secretModal.secret)}");
  });

  it.each(["fa", "id", "km", "pt-BR", "th", "zh-CN"])(
    "updates the existing %s translation without retaining the one-time claim",
    (locale) => {
      const translations = JSON.parse(readFileSync(
        new URL(`../../public/i18n/literals/${locale}.json`, import.meta.url),
        "utf-8"
      ));
      expect(translations).not.toHaveProperty(oldGuidance);
      expect(translations[guidance]).toEqual(expect.any(String));
      expect(translations[guidance].trim()).not.toBe("");
      expect(translations[guidance]).not.toBe(guidance);
    }
  );
});
