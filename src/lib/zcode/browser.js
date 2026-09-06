import { launch as cbLaunch } from "cloakbrowser";
import { chromium as pwChromium } from "playwright-core";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const USER_DATA_DIR = path.join(os.homedir(), ".cloakbrowser", "profiles", "9router-zcode");

export function parseProxyConfig(rawProxy) {
  if (!rawProxy) return undefined;
  try {
    const parsed = new URL(rawProxy);
    const username = decodeURIComponent(parsed.username || "");
    const password = decodeURIComponent(parsed.password || "");
    const server = `${parsed.protocol}//${parsed.host}`;
    return {
      server,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
      bypass: "localhost,127.0.0.1",
    };
  } catch {
    return { server: rawProxy, bypass: "localhost,127.0.0.1" };
  }
}

let browserInstance = null;
let currentMode = null;
let currentProxy = null;

function resolveSystemChromium() {
  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export async function launch(opts = {}) {
  const headless = opts.headless !== false;
  const requestedMode = headless ? "headless" : "headed";
  const requestedProxy = opts.proxy ? (typeof opts.proxy === "string" ? opts.proxy : opts.proxy.server || "") : null;

  if (browserInstance && currentMode === requestedMode && currentProxy === requestedProxy) {
    try {
      if (typeof browserInstance.contexts === "function") {
        browserInstance.contexts();
      } else if (typeof browserInstance.pages === "function") {
        browserInstance.pages();
      }
      return browserInstance;
    } catch {
      browserInstance = null;
    }
  }

  if (browserInstance) {
    await close();
  }

  const sysChromium = resolveSystemChromium();
  const launchArgs = [
    "--no-sandbox",
    "--no-first-run",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--mute-audio",
    "--no-zygote",
    "--window-size=1280,800",
    "--disable-blink-features=AutomationControlled",
  ];

  if (headless) {
    launchArgs.push("--headless=new");
  } else if (process.env.DISPLAY) {
    launchArgs.push(`--display=${process.env.DISPLAY}`);
  }

  const proxyConfig = parseProxyConfig(requestedProxy);

  // In Docker / Linux environments, use direct playwright-core with system Chromium
  // to avoid heavy software canvas fingerprint loops that burn 100% CPU.
  if (sysChromium && pwChromium) {
    browserInstance = await pwChromium.launch({
      headless: false,
      executablePath: sysChromium,
      args: launchArgs,
      proxy: proxyConfig,
    });

    browserInstance.on("disconnected", () => {
      browserInstance = null;
      currentMode = null;
      currentProxy = null;
    });

    currentMode = requestedMode;
    currentProxy = requestedProxy;
    return browserInstance;
  }

  const launchOpts = {
    headless,
    userDataDir: USER_DATA_DIR,
    args: launchArgs,
  };

  if (opts.proxy) {
    launchOpts.proxy = typeof opts.proxy === "string" ? parseProxyConfig(opts.proxy) : opts.proxy;
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
    const inst = browserInstance;
    browserInstance = null;
    currentMode = null;
    currentProxy = null;
    try {
      await Promise.race([
        inst.close(),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    } catch {
      // ignore
    }
  }
}
