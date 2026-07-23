/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY: string
  readonly VITE_FIREBASE_AUTH_DOMAIN: string
  readonly VITE_FIREBASE_PROJECT_ID: string
  readonly VITE_FIREBASE_STORAGE_BUCKET: string
  readonly VITE_FIREBASE_APP_ID: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface Window {
  // Firebase App Check debug-mode flag, read by the App Check SDK — not
  // declared in lib.dom.d.ts since it's a Firebase-only global.
  FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string
}
