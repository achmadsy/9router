import { cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

function copyIfExists(source, destination, label) {
  if (!existsSync(source)) return false;
  cpSync(source, destination, { recursive: true, force: true });
  console.log(`[standalone-assets] Copied ${label} to ${destination}`);
  return true;
}

export function copyStandaloneAssets({ projectRoot = process.cwd(), distDir = process.env.NEXT_DIST_DIR || ".next" } = {}) {
  if (process.env.NEXT_TRACING_ROOT_MODE === "workspace") {
    console.log("[standalone-assets] Skipping workspace-traced CLI build; CLI packaging handles assets");
    return;
  }

  const buildDir = resolve(projectRoot, distDir);
  const standaloneDir = resolve(buildDir, "standalone");

  if (!existsSync(standaloneDir)) {
    console.log(`[standalone-assets] No standalone build found at ${standaloneDir}`);
    return;
  }

  const staticSource = resolve(buildDir, "static");
  const staticDestination = resolve(standaloneDir, distDir, "static");
  copyIfExists(staticSource, staticDestination, "static assets");

  const publicSource = resolve(projectRoot, "public");
  const publicDestination = resolve(standaloneDir, "public");
  copyIfExists(publicSource, publicDestination, "public assets");

  // Without it beside server.js the standalone build serves requests unsanitized.
  const serverWrapperSource = resolve(projectRoot, "custom-server.js");
  const serverWrapperDestination = resolve(standaloneDir, "custom-server.js");
  copyIfExists(serverWrapperSource, serverWrapperDestination, "custom-server.js");

  // open-sse ships as raw ESM (Dockerfile copies ./open-sse). Its executors
  // and token-refresh code import sibling src/lib files at Node runtime —
  // Next file tracing never follows those relative paths, so they must live
  // next to open-sse inside standalone. Same reason Dockerfile used to COPY
  // them after .next/standalone.
  const runtimeSrcCopies = [
    ["src/lib/zcode", "src/lib/zcode"],
    ["src/lib/oauth", "src/lib/oauth"],
    ["src/lib/sentry.js", "src/lib/sentry.js"],
    ["src/lib/db", "src/lib/db"],
  ];
  for (const [rel, destRel] of runtimeSrcCopies) {
    copyIfExists(resolve(projectRoot, rel), resolve(standaloneDir, destRel), rel);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(dirname(fileURLToPath(import.meta.url)), "copy-standalone-assets.mjs")) {
  copyStandaloneAssets();
}
