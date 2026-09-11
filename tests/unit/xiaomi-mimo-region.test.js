import { describe, it, expect } from "vitest";
import {
  MIMO_REGIONS,
  resolveMimoAccount,
  scopedCookieNames,
  parseRegionFromStateCookie,
} from "../../open-sse/shared/mimoRegions.js";

/** Build the hex-encoded `state` cookie Desktop persists. */
function stateCookie(payload) {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("hex");
}

describe("MIMO_REGIONS table", () => {
  it("declares both account services with host and sid", () => {
    expect(MIMO_REGIONS.cn).toEqual({ host: "mimo-server-cn.xiaomimimo.com", sid: "mimopc" });
    expect(MIMO_REGIONS.sgp).toEqual({ host: "mimo-server-sgp.xiaomimimo.com", sid: "mimosgp" });
  });
});

describe("resolveMimoAccount", () => {
  it("defaults to China so existing accounts cannot regress", () => {
    expect(resolveMimoAccount(null)).toEqual({
      id: "cn",
      host: "mimo-server-cn.xiaomimimo.com",
      sid: "mimopc",
    });
  });

  it("honours an explicit per-connection override", () => {
    expect(resolveMimoAccount({ mimoRegion: "sgp" })).toEqual({
      id: "sgp",
      host: "mimo-server-sgp.xiaomimimo.com",
      sid: "mimosgp",
    });
  });

  it("honours the generic `region` key the Edit Connection dropdown writes", () => {
    // The region <Select> is shared plumbing and saves providerSpecificData.region,
    // so the dropdown must actually move the account service.
    expect(resolveMimoAccount({ region: "sgp" }).host).toBe("mimo-server-sgp.xiaomimimo.com");
    expect(resolveMimoAccount({ region: "cn" }).host).toBe("mimo-server-cn.xiaomimimo.com");
  });

  it("prefers mimoRegion over region when both are present", () => {
    expect(resolveMimoAccount({ mimoRegion: "sgp", region: "cn" }).id).toBe("sgp");
  });

  it("falls back to the default when the generic region key is unknown", () => {
    expect(resolveMimoAccount({ region: "ams" }).id).toBe("cn");
  });

  it("resolves the Singapore region Desktop signed in for", () => {
    expect(resolveMimoAccount(null, { host: "mimo-server-sgp.xiaomimimo.com", sid: "mimosgp" })).toEqual({
      id: "sgp",
      host: "mimo-server-sgp.xiaomimimo.com",
      sid: "mimosgp",
    });
  });

  it("resolves from a bare sid when no host was parsed", () => {
    expect(resolveMimoAccount(null, { host: null, sid: "mimosgp" }).id).toBe("sgp");
  });

  it("lets the override beat what was detected", () => {
    expect(resolveMimoAccount({ mimoRegion: "cn" }, { sid: "mimosgp" }).id).toBe("cn");
  });

  it("rejects an unknown region id and falls back to the default", () => {
    expect(resolveMimoAccount({ mimoRegion: "evil" }).id).toBe("cn");
  });

  it("never returns a host outside the allowlist (SSRF guard)", () => {
    const acct = resolveMimoAccount(null, { host: "attacker.example.com", sid: null });
    expect(acct.host).toBe("mimo-server-cn.xiaomimimo.com");
    expect(acct.host).not.toContain("attacker");
  });

  it("rejects a host that merely embeds an allowlisted name", () => {
    const acct = resolveMimoAccount(null, { host: "mimo-server-sgp.xiaomimimo.com.evil.tld", sid: null });
    expect(acct.id).toBe("cn");
  });
});

describe("scopedCookieNames", () => {
  it("derives the regional companion cookies from the sid", () => {
    expect(scopedCookieNames("mimopc")).toEqual(["mimopc_ph", "mimopc_slh"]);
    expect(scopedCookieNames("mimosgp")).toEqual(["mimosgp_ph", "mimosgp_slh"]);
  });
});

describe("parseRegionFromStateCookie", () => {
  it("reads the region out of a Desktop state cookie", () => {
    const hex = stateCookie({
      sid: "mimosgp",
      appid: "google_xiaomi_desktop_demo",
      callback:
        "https%3A%2F%2Fmimo-server-sgp.xiaomimimo.com%2Fapi%2Fsts%3Fsign%3Dabc%26followup%3Dhttp%253A%252F%252Fmimo-server-sgp.xiaomimimo.com%252Fapi%252Fuser%252Fxiaomi%252Fme",
    });
    expect(parseRegionFromStateCookie(hex)).toEqual({
      host: "mimo-server-sgp.xiaomimimo.com",
      sid: "mimosgp",
    });
  });

  it("parses a China state cookie too", () => {
    const hex = stateCookie({ sid: "mimopc", callback: "https%3A%2F%2Fmimo-server-cn.xiaomimimo.com%2Fapi%2Fsts" });
    expect(parseRegionFromStateCookie(hex)).toEqual({
      host: "mimo-server-cn.xiaomimimo.com",
      sid: "mimopc",
    });
  });

  it("still yields the sid when the callback URL is malformed", () => {
    expect(parseRegionFromStateCookie(stateCookie({ sid: "mimosgp", callback: "not a url" }))).toEqual({
      host: null,
      sid: "mimosgp",
    });
  });

  it("returns null for junk instead of throwing", () => {
    for (const bad of [null, undefined, "", "zzzz", "not-hex", stateCookie("a string"), stateCookie(42)]) {
      expect(parseRegionFromStateCookie(bad)).toBeNull();
    }
  });

  it("returns null when the state carries neither host nor sid", () => {
    expect(parseRegionFromStateCookie(stateCookie({ appid: "x" }))).toBeNull();
  });
});
