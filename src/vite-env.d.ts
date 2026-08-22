/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Development-only fallback for relay admission, inlined into the bundle at
   * build time (see .env.example) and therefore not secret.
   *
   * The app authenticates to the gated relay with the per-device account
   * credential from device-code sign-in; this token is used only when no stored
   * credential exists. Unset, and with no credential, the token is omitted from
   * start() entirely, which suits an ungated relay.
   */
  readonly VITE_RELAY_AUTH_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
