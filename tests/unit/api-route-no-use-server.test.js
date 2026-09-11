import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

// App Router route handlers must NOT use the "use server" directive.
// That directive registers exports as Server Actions (42-char reference IDs).
// Putting it on route.js makes Next try to resolve HTTP methods as server
// references and logs: The Server Reference ID did not match the expected
// format. Received "y". See src/app/api/cli-tools/**/route.js history.
const APP_ROOT = join(process.cwd(), "..", "src", "app");

function walkRouteJs(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkRouteJs(full, acc);
    else if (name === "route.js") acc.push(full);
  }
  return acc;
}

/**
 * True if the file's directive prologue starts with 'use server' / "use server".
 * Skips shebang, blank lines, // line comments, and block comments
 * (single- or multi-line) before the first statement. Only the prologue counts —
 * a string inside mid-file code is ignored.
 */
export function hasUseServerDirective(source) {
  let i = 0;
  if (source.startsWith("#!")) {
    const nl = source.indexOf("\n");
    i = nl === -1 ? source.length : nl + 1;
  }
  while (i < source.length) {
    const ch = source[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i + 2);
      if (nl === -1) return false;
      i = nl + 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) return false;
      i = end + 2;
      continue;
    }
    break;
  }
  const rest = source.slice(i);
  // First remaining token must be the directive; optional semicolon.
  return /^['"]use server['"]\s*;?/.test(rest);
}

describe("app/api route handlers", () => {
  it("does not use the use server directive", () => {
    const routes = walkRouteJs(APP_ROOT);
    expect(routes.length).toBeGreaterThan(0);
    const offenders = routes.filter((file) =>
      hasUseServerDirective(readFileSync(file, "utf8"))
    );
    expect(offenders).toEqual([]);
  });
});

describe("hasUseServerDirective prologue parser", () => {
  it("flags a bare directive at top", () => {
    expect(hasUseServerDirective("'use server';\nexport async function GET() {}")).toBe(true);
    expect(hasUseServerDirective('"use server"\nexport async function GET() {}')).toBe(true);
  });

  it("flags directives after shebang, blanks, and comments", () => {
    expect(
      hasUseServerDirective("#!/usr/bin/env node\n\n// hi\n'use server';\nexport async function GET() {}")
    ).toBe(true);
    expect(
      hasUseServerDirective("/* license\n * multi-line\n */\n\n\"use server\";\nexport async function GET() {}")
    ).toBe(true);
    expect(
      hasUseServerDirective("  \n// c\n\n\n\n'use server'\nexport async function GET() {}")
    ).toBe(true);
  });

  it("ignores mid-file code and non-directive strings", () => {
    expect(
      hasUseServerDirective("export async function GET() {}\n// 'use server'\nconst x = 1;")
    ).toBe(false);
    expect(
      hasUseServerDirective("export async function GET() { return Response.json({ msg: 'use server' }); }")
    ).toBe(false);
    expect(
      hasUseServerDirective("const s = \"'use server'\";\nexport async function GET() {}")
    ).toBe(false);
  });

  it("ignores comments that merely mention the phrase without a real directive", () => {
    expect(hasUseServerDirective("// never 'use server'\nexport async function GET() {}")).toBe(false);
    expect(
      hasUseServerDirective("/* use server is forbidden here */\nexport async function GET() {}")
    ).toBe(false);
  });
});
