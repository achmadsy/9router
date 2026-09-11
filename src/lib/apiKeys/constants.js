// API-key policy constants shared across DB, auth, and routes.
export const API_KEY_ACCESS_MODE = Object.freeze({
  ALL: "all",
  RESTRICTED: "restricted",
});

export const API_KEY_TARGET_TYPE = Object.freeze({
  MODEL: "model",
  COMBO: "combo",
});

export const API_KEY_HASH_VERSION = 1;

export const API_KEY_SECRET_PREFIX = "sk-9r-";
