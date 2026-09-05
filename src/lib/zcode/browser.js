import { launch as cbLaunch } from "cloakbrowser";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const USER_DATA_DIR = path.join(os.homedir(), ".cloakbrowser", "profiles", "9router-zcode");

let browserInstance = null;
let currentMode = null;
let currentProxy = null;

export async function launch(opts = {}) {
  const headless = opts.headless !== false;
  const requestedMode = headless ? "headless" : "headed";
  const requestedProxy = opts.proxy ? (typeof opts.proxy === "string" ? opts.proxy : opts.proxy.server || "") : null;

  if (browserInstance && currentMode === requestedMode && currentProxy === requestedProxy) {
    try {
      browserInstance.contexts();
      return browserInstance;
    } catch {
      browserInstance = null;
    }
  }

  if (browserInstance) {
    await close();
  }

  const launchOpts = {
    headless,
    userDataDir: USER_DATA_DIR,
    args: [
      "--no-sandbox",
      "--no-first-run",
      "--disable-default-apps",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  };

  if (opts.proxy) {
    launchOpts.proxy = typeof opts.proxy === "string" ? { server: opts.proxy } : opts.proxy;
  }

  // If running in Docker Alpine or CHROMIUM_PATH set, specify executablePath and CLOAKBROWSER_BINARY_PATH
  const chromiumPath =
    process.env.CLOAKBROWSER_BINARY_PATH ||
    process.env.CHROMIUM_PATH ||
    (process.platform === "linux" && "/usr/bin/chromium-browser");

  if (chromiumPath && typeof chromiumPath === "string") {
    try {
      if (fs.existsSync(chromiumPath)) {
        process.env.CLOAKBROWSER_BINARY_PATH = chromiumPath;
        launchOpts.executablePath = chromiumPath;
      }
    } catch {
      // ignore
    }
  }

  if (process.env.CLOAKBROWSER_SUPPRESS_FONT_WARNING === undefined) {
    process.env.CLOAKBROWSER_SUPPRESS_FONT_WARNING = "1";
  }

  browserInstance = await cbLaunch(launchOpts);

  browserInstance.on("disconnected", () => {
    browserInstance = null;
    currentMode = null;
    currentProxy = null;
  });

  currentMode = requestedMode;
  currentProxy = requestedProxy;
  return browserInstance;
}

export async function close() {
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch {
      // ignore
    }
    browserInstance = null;
    currentMode = null;
    currentProxy = null;
  }
}
