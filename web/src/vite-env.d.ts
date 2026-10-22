/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Prefills the API URL on the connect screen (set from the repo variable API_URL in CI). */
  readonly VITE_DEFAULT_API_URL?: string;
  /** "1" or "true" builds a demo-only dashboard backed by generated fixtures. */
  readonly VITE_DEMO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
