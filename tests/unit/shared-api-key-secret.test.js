import { afterEach, describe, expect, it, vi } from "vitest";

const originalSecret = process.env.API_KEY_SECRET;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  if (originalSecret === undefined) {
    delete process.env.API_KEY_SECRET;
  } else {
    process.env.API_KEY_SECRET = originalSecret;
  }
});

describe("shared API key secret fallback", () => {
  it("loads safely and warns when API_KEY_SECRET is absent", async () => {
    delete process.env.API_KEY_SECRET;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { generateApiKeyWithMachine, parseApiKey } = await import(
      "../../src/shared/utils/apiKey.js"
    );
    const generated = generateApiKeyWithMachine("machine123456789");

    expect(parseApiKey(generated.key)).toEqual({
      machineId: "machine123456789",
      keyId: generated.keyId,
      isNewFormat: true,
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("API_KEY_SECRET is not set")
    );
  });
});
