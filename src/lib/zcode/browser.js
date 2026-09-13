import { launch as cbLaunch, launchPersistentContext } from "cloakbrowser";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const USER_DATA_DIR = path.join(os.homedir(), ".cloakbrowser", "profiles", "9router-zcode");
const Xvfb_DISPLAY = ":99";

let browserContext = null;
let currentMode = null;
let currentProxy = "";
let xvfbProcess = null;

async function ensureXvfb() {
  if (process.env.DISPLAY) return;
  if (xvfbProcess && xvfbProcess.exitCode === null) return;
  try {
    xvfbProcess = spawn("Xvfb", [Xvfb_DISPLAY, "-screen", "0", "1920x1080x24", "-nolisten", "tcp"], {
      stdio: "ignore",
      detached: false,
    });
    xvfbProcess.unref?.();
    process.env.DISPLAY = Xvfb_DISPLAY;
    // Give Xvfb a moment to bind the display
    await new Promise((r) => setTimeout(r, 300));
  } catch (err) {
    console.warn("[ZCode Captcha] Xvfb unavailable:", err.message);
  }
}

/**
 * cloakbrowser launch() uses chromium.launch() which does not accept userDataDir.
 * Persistent profile requires launchPersistentContext (returns BrowserContext).
 * captcha-manager only needs contexts()[0].newPage() — BrowserContext works
 * via a thin shim so callers keep the same shape.
 */
function wrapContextAsBrowser(context) {
  return {
    contexts: () => [context],
    newContext: async () => context,
    on: (event, fn) => context.browser?.()?.on?.(event, fn),
    close: async () => {
      try {
        await context.close();
      } catch {}
    },
  };
}

export async function launch(opts = {}) {
  const headless = opts.headless !== false;
  const requestedMode = headless ? "headless" : "headed";
  const proxy = (opts.proxy || "").trim();

  if (browserContext && currentMode === requestedMode && currentProxy === proxy) {
    try {
      // touch the context; throws if closed
      await browserContext.pages();
      return wrapContextAsBrowser(browserContext);
    } catch {
      browserContext = null;
    }
  }

  if (browserContext) {
    await close();
  }

  if (!headless) {
    await ensureXvfb();
  }

  try {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  } catch {}

  const args = [
    "--no-sandbox",
    "--no-first-run",
    "--disable-default-apps",
    "--disable-gpu",
    "--disable-crash-reporter",
    "--disable-dev-shm-usage",
    "--disable-software-rasterizer",
    // Chromium 146 in Docker often SIGTRAPs without this
    "--no-zygote",
  ];

  browserContext = await launchPersistentContext({
    headless,
    userDataDir: USER_DATA_DIR,
    args,
    // cloakbrowser accepts http(s)/socks5 URL; credentials auto-extracted
    ...(proxy ? { proxy } : {}),
  });

  // Headed Chrome needs a "closed" signal; Playwright context close is enough.
  currentMode = requestedMode;
  currentProxy = proxy;
  return wrapContextAsBrowser(browserContext);
}

export async function close() {
  if (browserContext) {
    try {
      await browserContext.close();
    } catch {
      // ignore
    }
    browserContext = null;
    currentMode = null;
    currentProxy = "";
  }
  // Leave Xvfb running for possible headed retries
}
