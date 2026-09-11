import { describe, expect, it } from "vitest";
import {
  captureScrollAnchor,
  isAtBottom,
  reconcileInitEntries,
  restoreScrollAnchor,
} from "../../src/app/(dashboard)/dashboard/console-log/scrollAnchor.js";

function makeLine(id, top, bottom) {
  return {
    getAttribute: (name) => (name === "data-log-line" ? id : null),
    getBoundingClientRect: () => ({ top, bottom, height: bottom - top }),
  };
}

function makeEntries(lines) {
  let seq = 0;
  return lines.map((text) => ({ id: `log-${seq++}`, text }));
}

const appendEntries = (lines) => lines.map((text) => ({ id: `new-${text}`, text }));
const trimToMax = (entries, max = 1000) =>
  entries.length > max ? entries.slice(entries.length - max) : entries;

function makeContainer({ top = 100, lines = [], scrollTop = 0 } = {}) {
  return {
    scrollTop,
    getBoundingClientRect: () => ({ top, bottom: top + 400 }),
    querySelectorAll: () => lines,
    querySelector: (sel) => {
      const id = sel.match(/\[data-log-line="(.*)"\]$/)?.[1];
      if (id == null) return null;
      return lines.find((l) => l.getAttribute("data-log-line") === id) || null;
    },
  };
}

describe("isAtBottom", () => {
  it("treats missing element as at bottom", () => {
    expect(isAtBottom(null)).toBe(true);
  });

  it("true when within threshold of bottom", () => {
    const el = { scrollTop: 596, scrollHeight: 1000, clientHeight: 400 };
    expect(isAtBottom(el, 4)).toBe(true);
  });

  it("false when scrolled up", () => {
    const el = { scrollTop: 100, scrollHeight: 1000, clientHeight: 400 };
    expect(isAtBottom(el, 4)).toBe(false);
  });
});

describe("captureScrollAnchor / restoreScrollAnchor", () => {
  it("captures first line whose bottom is below container top", () => {
    const line0 = makeLine("1", 80, 96); // above viewport
    const line1 = makeLine("2", 97, 113); // partially/fully visible
    const el = makeContainer({ top: 100, lines: [line0, line1] });
    const anchor = captureScrollAnchor(el);
    expect(anchor).toEqual({ id: "2", offset: -3 });
  });

  it("returns null for empty list", () => {
    expect(captureScrollAnchor(makeContainer({ lines: [] }))).toBeNull();
    expect(captureScrollAnchor(null)).toBeNull();
  });

  it("shifts scrollTop so anchor line keeps same offset after top trim", () => {
    // After trim, line "2" moved up by 20px (was offset 10, now -10)
    const line2 = makeLine("2", 90, 106);
    const el = makeContainer({ top: 100, lines: [line2], scrollTop: 500 });
    restoreScrollAnchor(el, { id: "2", offset: 10 });
    // newOffset = 90 - 100 = -10; scrollTop += -10 - 10 = -20 → 480
    expect(el.scrollTop).toBe(480);
  });

  it("no-op when anchor line was trimmed away", () => {
    const line3 = makeLine("3", 100, 116);
    const el = makeContainer({ top: 100, lines: [line3], scrollTop: 200 });
    restoreScrollAnchor(el, { id: "2", offset: 0 });
    expect(el.scrollTop).toBe(200);
  });
});

describe("reconcileInitEntries", () => {
  it("hydrates when client has no lines yet", () => {
    const next = reconcileInitEntries([], ["a", "b"], appendEntries, trimToMax);
    expect(next.map((e) => e.text)).toEqual(["a", "b"]);
  });

  it("keeps existing entry identity and appends only missed tail", () => {
    const prev = makeEntries(["a", "b", "c"]);
    const next = reconcileInitEntries(prev, ["a", "b", "c", "d", "e"], appendEntries, trimToMax);
    // Same object identity for already-rendered rows — no remount.
    expect(next[0]).toBe(prev[0]);
    expect(next[1]).toBe(prev[1]);
    expect(next[2]).toBe(prev[2]);
    expect(next.map((e) => e.text)).toEqual(["a", "b", "c", "d", "e"]);
    expect(next.slice(3).map((e) => e.id)).toEqual(["new-d", "new-e"]);
  });

  it("returns prev unchanged when server has nothing new", () => {
    const prev = makeEntries(["a", "b"]);
    const next = reconcileInitEntries(prev, ["a", "b"], appendEntries, trimToMax);
    expect(next).toBe(prev);
  });

  it("handles server ring trim: keeps local rows, appends only new", () => {
    // Client still has a,b,c; server already trimmed to c,d,e,f
    const prev = makeEntries(["a", "b", "c"]);
    const next = reconcileInitEntries(prev, ["c", "d", "e", "f"], appendEntries, trimToMax);
    expect(next[0]).toBe(prev[0]);
    // Overlap on "c" → append d,e,f after keeping a,b,c
    expect(next.map((e) => e.text)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("prefers longest overlap so duplicate line text cannot swallow the tail", () => {
    // prev ends with two "x"; server has three "x". Must append one "x".
    const prev = makeEntries(["a", "x", "x"]);
    const next = reconcileInitEntries(prev, ["a", "x", "x", "x"], appendEntries, trimToMax);
    expect(next.map((e) => e.text)).toEqual(["a", "x", "x", "x"]);
    expect(next).toHaveLength(4);
  });

  it("among equal-length duplicate matches, takes earliest start and keeps missed tail", () => {
    // prev ["x","x"] vs server ["x","x","x"]: k=2 matches at start 0 AND 1.
    // Latest-occurrence matching would take start=1, remainder=[], drop a line.
    const prev = makeEntries(["x", "x"]);
    const next = reconcileInitEntries(prev, ["x", "x", "x"], appendEntries, trimToMax);
    expect(next.map((e) => e.text)).toEqual(["x", "x", "x"]);
    expect(next).toHaveLength(3);
  });

  it("equal-length duplicates mid-buffer keep longest tail after earliest match", () => {
    // prev ends ["x","x"]; server ["y","x","x","x","z"]. k=2 at start 1 or 2;
    // earliest (1) yields remainder ["x","z"], latest (2) would lose "z".
    const prev = makeEntries(["y", "x", "x"]);
    const next = reconcileInitEntries(prev, ["y", "x", "x", "x", "z"], appendEntries, trimToMax);
    expect(next.map((e) => e.text)).toEqual(["y", "x", "x", "x", "z"]);
    expect(next).toHaveLength(5);
  });

  it("hydrates from server when there is no shared suffix (restart)", () => {
    const prev = makeEntries(["old-1", "old-2"]);
    const next = reconcileInitEntries(prev, ["fresh"], appendEntries, trimToMax);
    expect(next.map((e) => e.text)).toEqual(["fresh"]);
    expect(next[0]).not.toBe(prev[0]);
  });

  it("keeps prev when init replay is empty", () => {
    const prev = makeEntries(["a"]);
    expect(reconcileInitEntries(prev, [], appendEntries, trimToMax)).toBe(prev);
  });

  it("applies maxLines trim after append", () => {
    const prev = makeEntries(["a", "b", "c"]);
    const next = reconcileInitEntries(prev, ["a", "b", "c", "d", "e"], appendEntries, (entries) =>
      entries.slice(-3)
    );
    expect(next.map((e) => e.text)).toEqual(["c", "d", "e"]);
  });
});
