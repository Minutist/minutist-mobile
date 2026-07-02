/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Relay admission token for the gated sync relay, injected at BUILD time for
   * dev/test builds (see .env.example) and inlined into the bundle — development
   * use only. Production sources a per-user admission token from the account
   * service at runtime instead. Unset ⇒ the token is omitted from start().
   */
  readonly VITE_RELAY_AUTH_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
