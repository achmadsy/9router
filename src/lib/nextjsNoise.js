// Next.js internal telemetry noise filters.
//
// Next.js's OTEL tracer emits console.warn lines when span bookkeeping gets
// confused — e.g. a fetch span leaking in as the root span on cold starts
// (upstream bug vercel/next.js#91831). These are known-harmless framework
// diagnostics, not 9Router issues: they flood the dashboard log buffer and,
// worse, can masquerade as real problems in Sentry. Recognize them by prefix
// so both consoleLogBuffer and the Sentry capture path can drop them on
// sight.

// "Unexpected root span type 'AppRender.fetch'. Please report this Next.js issue …"
// Span types are dotted identifiers (AppRender.fetch, Node.runHandler, …).
const NEXTJS_SPAN_WARNING_RE = /^Unexpected root span type '[^']+'\./;

export function isNextjsSpanWarning(line) {
  return typeof line === "string" && NEXTJS_SPAN_WARNING_RE.test(line);
}
