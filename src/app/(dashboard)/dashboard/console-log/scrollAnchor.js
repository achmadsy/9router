// Scroll-anchoring helpers for the console log ring buffer.
// When the user is NOT autoscrolling, keep their reading position stationary
// even if lines are appended at the bottom or trimmed from the top.

export function isAtBottom(el, threshold = 4) {
  if (!el) return true;
  const { scrollTop, scrollHeight, clientHeight } = el;
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

/**
 * Capture which log line is currently at the top of the viewport and its
 * offset from the scroll container's top edge. Call BEFORE mutating the list.
 */
export function captureScrollAnchor(el) {
  if (!el) return null;
  const containerTop = el.getBoundingClientRect().top;
  const lines = el.querySelectorAll("[data-log-line]");
  for (const line of lines) {
    const rect = line.getBoundingClientRect();
    if (rect.bottom > containerTop + 1) {
      return {
        id: line.getAttribute("data-log-line"),
        offset: rect.top - containerTop,
      };
    }
  }
  return null;
}

/**
 * Restore a previously captured anchor after the list re-renders.
 * No-op if the anchor line was trimmed off the ring buffer.
 */
export function restoreScrollAnchor(el, anchor) {
  if (!el || !anchor || anchor.id == null) return;
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(anchor.id)
      : String(anchor.id).replace(/["\\]/g, "\\$&");
  const line = el.querySelector(`[data-log-line="${escaped}"]`);
  if (!line) return;
  const containerTop = el.getBoundingClientRect().top;
  const newOffset = line.getBoundingClientRect().top - containerTop;
  el.scrollTop += newOffset - anchor.offset;
}

/**
 * Reconcile a reconnect `init` replay against lines already on screen.
 *
 * Server buffer is an ordered append-only ring. Client `prev` is also
 * append-only (stable ids, optional top-trim). Walk the longest suffix of
 * `prev` that still matches a contiguous slice of the server buffer; append
 * only the remainder (lines produced while disconnected). Among equal-length
 * matches, prefer the EARLIEST position in the server buffer so the remainder
 * is the longest possible tail (server is the authoritative contiguous
 * window). Longest k still wins over a shorter earlier match. No overlap ⇒
 * server restarted/diverged: hydrate from the replay (remount). Empty replay
 * keeps what we already rendered.
 *
 * `appendEntries` builds entries for the missed tail (same as line/lines
 * handlers). Pure for unit tests — no DOM, no React.
 */
export function reconcileInitEntries(prev, serverLogs, appendEntries, trimToMax) {
  const server = Array.isArray(serverLogs) ? serverLogs : [];
  if (!Array.isArray(prev) || prev.length === 0) {
    return trimToMax(appendEntries(server));
  }
  if (server.length === 0) return prev;

  const prevTexts = prev.map((e) => e.text);
  const maxK = Math.min(prevTexts.length, server.length);
  let matchStart = -1;
  let matchLen = 0;

  for (let k = maxK; k >= 1; k--) {
    const suffix = prevTexts.slice(prevTexts.length - k);
    for (let start = 0; start <= server.length - k; start++) {
      let ok = true;
      for (let j = 0; j < k; j++) {
        if (server[start + j] !== suffix[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        matchStart = start;
        matchLen = k;
        break;
      }
    }
    if (matchStart !== -1) break;
  }

  if (matchStart === -1) {
    // No shared suffix — treat as a fresh buffer (process/server restart).
    return trimToMax(appendEntries(server));
  }

  const remainder = server.slice(matchStart + matchLen);
  if (remainder.length === 0) return prev;
  return trimToMax([...prev, ...appendEntries(remainder)]);
}
