const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export const MAX_PROBE_HEADERS = 16;
export const MAX_PROBE_HEADER_NAME_LENGTH = 128;
export const MAX_PROBE_HEADER_VALUE_LENGTH = 2048;
export const MAX_PROBE_HEADERS_BYTES = 8192;

const BLOCKED_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-9r-cli-token",
  "x-probe-sidecar-token",
]);

function entriesFrom(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.map((entry) => [entry?.name, entry?.value]);
  }
  if (typeof value === "object") return Object.entries(value);
  throw new Error("Additional headers must be an object or list of name/value rows");
}

export function normalizeProbeCustomHeaders(value) {
  const entries = entriesFrom(value);
  if (entries.length > MAX_PROBE_HEADERS) {
    throw new Error(`Additional headers cannot exceed ${MAX_PROBE_HEADERS} entries`);
  }

  const normalized = {};
  const seen = new Set();
  let totalBytes = 0;

  for (const [rawName, rawValue] of entries) {
    const name = typeof rawName === "string" ? rawName.trim() : "";
    const headerValue = typeof rawValue === "string" ? rawValue : "";
    if (!name && !headerValue) continue;
    if (!name || typeof rawValue !== "string") {
      throw new Error("Each additional header requires a name and value");
    }
    if (name.length > MAX_PROBE_HEADER_NAME_LENGTH || !HEADER_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid additional header name: ${name.slice(0, MAX_PROBE_HEADER_NAME_LENGTH) || "(empty)"}`);
    }
    if (headerValue.length > MAX_PROBE_HEADER_VALUE_LENGTH) {
      throw new Error(`Additional header ${name} value is too long`);
    }
    if (/[\u0000-\u001F\u007F-\u009F]/u.test(headerValue)) {
      throw new Error(`Additional header ${name} contains invalid control characters`);
    }

    const lowerName = name.toLowerCase();
    if (BLOCKED_HEADERS.has(lowerName) || lowerName.startsWith("proxy-")) {
      throw new Error(`Additional header ${name} is not allowed`);
    }
    if (seen.has(lowerName)) {
      throw new Error(`Duplicate additional header: ${name}`);
    }

    totalBytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(headerValue, "utf8") + 4;
    if (totalBytes > MAX_PROBE_HEADERS_BYTES) {
      throw new Error(`Additional headers cannot exceed ${MAX_PROBE_HEADERS_BYTES} bytes`);
    }

    seen.add(lowerName);
    normalized[name] = headerValue;
  }

  return normalized;
}
