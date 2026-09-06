import { launch as launchBrowser, close as closeBrowser } from "./browser.js";
import config from "./config.js";

export class CaptchaManager {
  constructor() {
    this.cachedVerifyParam = null;
    this.pendingPromise = null;
    this.resolveCallback = null;
    this.rejectCallback = null;
    this.captchaPage = null;
    this.captchaConfigCache = null;
    this.captchaConfigCacheTime = 0;
    this._clearCacheTimer = null;
    this._captchaTimeoutId = null;
    this._headlessTimeoutId = null;
    this._verificationPhase = null;
    this._headedFallbackAttempted = false;
    this._activePort = config.captchaPort;
  }

  async fetchCaptchaConfig() {
    const now = Date.now();
    if (this.captchaConfigCache && now - this.captchaConfigCacheTime < config.captchaConfigCacheTTL) {
      return this.captchaConfigCache;
    }

    try {
      const res = await fetch(
        `https://zcode.z.ai/api/v1/client/configs?app_version=${config.appVersion}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const captchaConfig = json.data?.configs?.captcha;
      if (captchaConfig) {
        this.captchaConfigCache = captchaConfig;
        this.captchaConfigCacheTime = now;
        return captchaConfig;
      }
    } catch (err) {
      console.error("[ZCode Captcha] Failed to fetch config, using defaults:", err.message);
    }

    return {
      enabled: true,
      prefix: "no8xfe",
      region: "sgp",
      sceneId: "11xygtvd",
    };
  }

  _clearVerificationTimers() {
    if (this._captchaTimeoutId) {
      clearTimeout(this._captchaTimeoutId);
      this._captchaTimeoutId = null;
    }
    if (this._headlessTimeoutId) {
      clearTimeout(this._headlessTimeoutId);
      this._headlessTimeoutId = null;
    }
  }

  _rejectPending(err) {
    this._clearVerificationTimers();
    if (this.rejectCallback) {
      this.rejectCallback(err);
    }
    this.pendingPromise = null;
    this.resolveCallback = null;
    this.rejectCallback = null;
    this._verificationPhase = null;
    this._headedFallbackAttempted = false;
  }

  async _resolvePending(verifyParam) {
    this._clearVerificationTimers();
    if (this.resolveCallback) {
      this.resolveCallback(verifyParam);
    }
    this.pendingPromise = null;
    this.resolveCallback = null;
    this.rejectCallback = null;
    this._verificationPhase = null;
    this._headedFallbackAttempted = false;
    await this._closeCaptchaPage();
  }

  _armPhaseTimeout(phase) {
    this._clearVerificationTimers();

    const timeoutMs =
      phase === "headed"
        ? config.captchaInteractiveTimeoutMs
        : config.captchaHeadlessTimeoutMs;

    this._captchaTimeoutId = setTimeout(() => {
      if (phase === "headless" && config.captchaHeadedFallback && !this._headedFallbackAttempted) {
        console.warn(
          `[ZCode Captcha] Traceless verification timed out after ${Math.round(timeoutMs / 1000)}s, opening visible browser...`
        );
        this.onNeedsInteractive().catch((err) => {
          console.error("[ZCode Captcha] Headed fallback failed:", err.message);
          this._rejectPending(
            new Error(
              `Captcha verification timed out. Complete the puzzle in the browser window or retry later. (${err.message})`
            )
          );
        });
        return;
      }

      this._rejectPending(
        new Error(
          phase === "headed"
            ? `Interactive captcha timed out after ${Math.round(timeoutMs / 1000)}s. Complete the puzzle in the browser window and retry.`
            : `Traceless captcha verification timed out after ${Math.round(timeoutMs / 1000)}s. ` +
              (process.platform === "linux" && !process.env.DISPLAY
                ? "Interactive captcha puzzle is required by upstream, but no X display is available in this environment."
                : "Ensure CloakBrowser can reach /zcode/captcha.html and retry.")
        )
      );
    }, timeoutMs);
  }

  async _closeCaptchaPage() {
    if (!this.captchaPage) return;
    try {
      await this.captchaPage.close();
    } catch {
      // ignore
    }
    this.captchaPage = null;
  }

  async openVerificationPage(port = config.captchaPort, { headless = true, interactive = false, proxy = null } = {}) {
    this._activePort = port;
    this._activeProxy = proxy;
    this._verificationPhase = headless ? "headless" : "headed";

    if (this.captchaPage && !this.captchaPage.isClosed()) {
      if (!interactive) {
        try {
          await this.captchaPage.evaluate(() => {
            if (typeof window.__resetCaptcha === "function") {
              return window.__resetCaptcha();
            }
          });
          this._armPhaseTimeout(this._verificationPhase);
          return;
        } catch (err) {
          console.warn("[ZCode Captcha] page.evaluate failed, reopening page:", err.message);
          await this._closeCaptchaPage();
        }
      } else {
        await this._closeCaptchaPage();
      }
    }

    const browserInstance = await launchBrowser({ headless, proxy });
    let context;
    if (typeof browserInstance.contexts === "function") {
      context = browserInstance.contexts()[0];
      if (!context) {
        context = await browserInstance.newContext({
          viewport: { width: 1280, height: 800 },
          userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
        });
      }
    } else {
      context = browserInstance;
    }

    if (context && typeof context.addInitScript === "function") {
      await context.addInitScript(() => {
        try {
          Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        } catch {}
      });
    }

    this.captchaPage = await context.newPage();

    if (proxy) {
      try {
        const parsed = new URL(proxy);
        if (parsed.username && parsed.password) {
          const auth = {
            username: decodeURIComponent(parsed.username),
            password: decodeURIComponent(parsed.password),
          };
          if (typeof this.captchaPage.authenticate === "function") {
            await this.captchaPage.authenticate(auth);
          }
        }
      } catch {}
    }

    const query = interactive ? "?mode=interactive" : "";
    await this.captchaPage.goto(`http://localhost:${port}/zcode/captcha.html${query}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    this.captchaPage.on("close", () => {
      this.captchaPage = null;
    });

    this._armPhaseTimeout(this._verificationPhase);

    if (!headless) {
      console.log(
        "[ZCode Captcha] Visible browser opened — complete the security puzzle in the window to continue."
      );
    }
  }

  async onNeedsInteractive() {
    if (!this.pendingPromise || this._headedFallbackAttempted || !config.captchaHeadedFallback) {
      return;
    }

    this._headedFallbackAttempted = true;
    await this._closeCaptchaPage();
    await closeBrowser();
    await this.openVerificationPage(this._activePort, { headless: false, interactive: true, proxy: this._activeProxy });
  }

  async getVerifyParam(port = config.captchaPort, options = {}) {
    if (this.cachedVerifyParam) {
      return this.cachedVerifyParam;
    }

    if (this.pendingPromise) {
      return this.pendingPromise;
    }

    const headless = options.headless !== false;
    const interactive = options.interactive === true;

    this._headedFallbackAttempted = !headless;
    this._activePort = port;
    this._activeProxy = options.proxy || null;

    this.pendingPromise = new Promise((resolve, reject) => {
      this.resolveCallback = resolve;
      this.rejectCallback = reject;
    });

    this.openVerificationPage(port, { headless, interactive, proxy: options.proxy || null }).catch((err) => {
      this._rejectPending(new Error("Browser launch failed: " + err.message));
    });

    return this.pendingPromise;
  }

  submit(verifyParam) {
    if (this.resolveCallback) {
      this._resolvePending(verifyParam);
    }

    if (this._clearCacheTimer) {
      clearTimeout(this._clearCacheTimer);
      this._clearCacheTimer = null;
    }

    this.cachedVerifyParam = verifyParam;
    this._clearCacheTimer = setTimeout(() => {
      this.cachedVerifyParam = null;
      this._clearCacheTimer = null;
    }, config.captchaCacheTTL);
  }

  invalidate() {
    this.cachedVerifyParam = null;
    if (this._clearCacheTimer) {
      clearTimeout(this._clearCacheTimer);
      this._clearCacheTimer = null;
    }
  }

  async close() {
    this._clearVerificationTimers();
    await this._closeCaptchaPage();
  }
}
