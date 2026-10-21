import {
  ORIGINAL_SUITE_CATEGORY_BY_ID,
  ORIGINAL_SUITE_GROUPS,
  ORIGINAL_SUITE_IDS,
} from "@/lib/probe/originalSuite.js";

// Categories and membership mirror the original BazaarLink 86-probe report.
export const PROBE_CATEGORIES = [
  { id: "identity", label: "Identity", color: "#8B5CF6", badgeVariant: "primary", neutral: true },
  { id: "submodel", label: "Sub-Model ID", color: "#06B6D4", badgeVariant: "default", neutral: true },
  { id: "security", label: "Security Probes", color: "#EF4444", badgeVariant: "error" },
  { id: "integrity", label: "Integrity Checks", color: "#3B82F6", badgeVariant: "info" },
];

export const CATEGORY_MAP = Object.fromEntries(
  PROBE_CATEGORIES.map((cat, idx) => [cat.id, { ...cat, index: idx }])
);

export function getProbeDisplayGroup(probe) {
  return ORIGINAL_SUITE_CATEGORY_BY_ID.get(probe?.id) || null;
}

// Back-compat alias for older call sites.
export const getProbeDisplayCategories = (probe) => {
  const group = getProbeDisplayGroup(probe);
  return group ? [group] : [];
};

const FALLBACK_LABEL_OVERRIDES = {
  identity_style_en: "Style — English",
  identity_style_zh_tw: "Style — Traditional Chinese",
  identity_reasoning_shape: "Reasoning Shape",
  identity_self_knowledge: "Self-Knowledge",
  identity_list_format: "List Format",
  identity_refusal_pattern: "Refusal Pattern",
  identity_json_discipline: "JSON Discipline",
  identity_capability_claim: "Capability Claim",
  zh_creator_plain: "Chinese axis — creator identity",
  zh_region_boundary_taiwan: "Chinese axis — regional alignment",
  zh_who_built_pressure: "Chinese axis — pressured identity",
};

function fallbackLabel(id) {
  return FALLBACK_LABEL_OVERRIDES[id] || id
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export const DEFAULT_PROBES = ORIGINAL_SUITE_IDS.map((id) => ({
  id,
  label: fallbackLabel(id),
  group: ORIGINAL_SUITE_CATEGORY_BY_ID.get(id),
  neutral: ORIGINAL_SUITE_CATEGORY_BY_ID.get(id) === "identity"
    || ORIGINAL_SUITE_CATEGORY_BY_ID.get(id) === "submodel",
  description: "Probe metadata loads from the engine catalog.",
}));

export { ORIGINAL_SUITE_GROUPS, ORIGINAL_SUITE_IDS };

export const STATUS_META = {
  pending: {
    icon: "radio_button_unchecked",
    label: "Pending",
    bgClass: "bg-surface-2",
    borderClass: "border-border-subtle",
    textClass: "text-text-muted",
  },
  running: {
    icon: "progress_activity",
    label: "Running",
    bgClass: "bg-brand-500/10",
    borderClass: "border-brand-500",
    textClass: "text-brand-500",
  },
  passed: {
    icon: "check_circle",
    label: "Passed",
    bgClass: "bg-emerald-500/15",
    borderClass: "border-emerald-500",
    textClass: "text-emerald-600 dark:text-emerald-400",
  },
  failed: {
    icon: "cancel",
    label: "Failed",
    bgClass: "bg-red-500/15",
    borderClass: "border-red-500",
    textClass: "text-red-600 dark:text-red-400",
  },
  neutral: {
    icon: "lens",
    label: "Neutral Evidence",
    bgClass: "bg-purple-500/15",
    borderClass: "border-purple-500",
    textClass: "text-purple-600 dark:text-purple-400",
  },
  error: {
    icon: "error",
    label: "Error",
    bgClass: "bg-amber-500/15",
    borderClass: "border-amber-500",
    textClass: "text-amber-600 dark:text-amber-400",
  },
  skipped: {
    icon: "do_not_disturb_on",
    label: "Skipped",
    bgClass: "bg-surface-3",
    borderClass: "border-border",
    textClass: "text-text-muted",
  },
};

export const VERDICT_MAP = {
  clean_match: {
    label: "Verified Authentic",
    badgeVariant: "success",
    description: "Endpoint behavior, styling, and tokenizer match the claimed model.",
  },
  clean_match_submodel_mismatch: {
    label: "Sub-model Variant Mismatch",
    badgeVariant: "warning",
    description: "Matches the correct model family but differs in parameter size or sub-release.",
  },
  spoof_suspected: {
    label: "Spoofing Suspected",
    badgeVariant: "error",
    description: "Model signatures show significant divergence from genuine endpoints.",
  },
  spoof_confirmed: {
    label: "Spoofing Detected",
    badgeVariant: "error",
    description: "Identity and capability cliff tests confirm this is a disguised alternate model.",
  },
  plain_mismatch: {
    label: "Identity Mismatch",
    badgeVariant: "error",
    description: "Model family does not correspond to claimed identity.",
  },
  abstain: {
    label: "Inconclusive",
    badgeVariant: "default",
    description: "Insufficient signal to confirm or refute identity with high confidence.",
  },
};
