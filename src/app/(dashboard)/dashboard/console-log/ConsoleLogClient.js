"use client";

import { useState, useEffect, useLayoutEffect, useRef } from "react";
import { Card, Button } from "@/shared/components";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";
import {
  captureScrollAnchor,
  isAtBottom,
  reconcileInitEntries,
  restoreScrollAnchor,
} from "./scrollAnchor";

const LOG_LEVEL_COLORS = {
  LOG: "text-green-400",
  INFO: "text-blue-400",
  WARN: "text-yellow-400",
  ERROR: "text-red-400",
  DEBUG: "text-purple-400",
};

function colorLine(line) {
  const match = line.match(/\[(\w+)\]/g);
  const levelTag = match ? match[1]?.replace(/\[|\]/g, "") : null;
  const color = LOG_LEVEL_COLORS[levelTag] || "text-green-400";
  return <span className={color}>{line}</span>;
}

let nextLogId = 1;

function toLogEntries(lines) {
  const list = Array.isArray(lines) ? lines : [lines];
  return list.map((text) => ({ id: nextLogId++, text }));
}

function trimToMax(entries) {
  return entries.length > CONSOLE_LOG_CONFIG.maxLines ? entries.slice(-CONSOLE_LOG_CONFIG.maxLines) : entries;
}

export default function ConsoleLogClient() {
  const [logs, setLogs] = useState([]);
  const [connected, setConnected] = useState(false);
  const logRef = useRef(null);
  const shouldAutoScrollRef = useRef(true);
  const pendingAnchorRef = useRef(null);

  const handleScroll = () => {
    if (!logRef.current) return;
    shouldAutoScrollRef.current = isAtBottom(logRef.current);
  };

  const handleClear = async () => {
    try {
      await fetch("/api/translator/console-logs", { method: "DELETE" });
      // UI cleared via SSE "clear" event
    } catch (err) {
      console.error("Failed to clear console logs:", err);
    }
  };

  useEffect(() => {
    const es = new EventSource("/api/translator/console-logs/stream");

    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "init") {
        // Reconnect replays the full server ring with new ids. Do not remount:
        // keep current entries (stable ids), append only lines missed while
        // disconnected. First paint hydrates; no-overlap restart falls back to
        // hydrate inside reconcileInitEntries.
        setLogs((prev) => {
          const next = reconcileInitEntries(prev, msg.logs, toLogEntries, trimToMax);
          if (next === prev) return prev;
          pendingAnchorRef.current = shouldAutoScrollRef.current
            ? null
            : captureScrollAnchor(logRef.current);
          return next;
        });
      } else if (msg.type === "line") {
        // Capture anchor before list mutates so a non-autoscroll reader stays put.
        pendingAnchorRef.current = shouldAutoScrollRef.current ? null : captureScrollAnchor(logRef.current);
        setLogs((prev) => trimToMax([...prev, ...toLogEntries(msg.line)]));
      } else if (msg.type === "lines") {
        pendingAnchorRef.current = shouldAutoScrollRef.current ? null : captureScrollAnchor(logRef.current);
        setLogs((prev) => trimToMax([...prev, ...toLogEntries(msg.lines)]));
      } else if (msg.type === "clear") {
        setLogs([]);
      }
    };

    es.onerror = () => setConnected(false);

    return () => es.close();
  }, []);

  // After paint: stick to bottom if autoscrolling, else restore reading position.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el) return;

    if (shouldAutoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
    } else if (pendingAnchorRef.current) {
      restoreScrollAnchor(el, pendingAnchorRef.current);
    }
    pendingAnchorRef.current = null;
  }, [logs]);

  return (
    <div className="">
      <Card>
        <div className="flex items-center justify-end px-4 pt-3 pb-2">
          <Button size="sm" variant="outline" icon="delete" onClick={handleClear}>
            Clear
          </Button>
        </div>
        <div
          ref={logRef}
          onScroll={handleScroll}
          className="bg-black rounded-b-lg p-4 text-xs font-mono h-[calc(100vh-220px)] overflow-y-auto"
        >
          {logs.length === 0 ? (
            <span className="text-text-muted">No console logs yet.</span>
          ) : (
            <div className="space-y-0.5">
              {logs.map((entry) => (
                <div key={entry.id} data-log-line={entry.id}>
                  {colorLine(entry.text)}
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
