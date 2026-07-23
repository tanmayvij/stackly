/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Required (validated at boot by src/lib/env.ts). Keep in sync with
  // .env.example and the env.ts REQUIRED_ENV_VARS list.
  readonly VITE_FIREBASE_API_KEY: string
  readonly VITE_FIREBASE_AUTH_DOMAIN: string
  readonly VITE_FIREBASE_PROJECT_ID: string
  readonly VITE_FIREBASE_STORAGE_BUCKET: string
  readonly VITE_FIREBASE_APP_ID: string
  readonly VITE_FUNCTIONS_REGION: string
  readonly VITE_RECAPTCHA_SITE_KEY: string
  readonly VITE_STRIPE_PUBLISHABLE_KEY: string
  readonly VITE_GHL_CLIENT_ID: string
  readonly VITE_GHL_REDIRECT_URI: string
  readonly VITE_GHL_SCOPES: string
  readonly VITE_GHL_VERSION_ID: string
  // Optional overrides.
  readonly VITE_USE_EMULATORS?: string
  readonly VITE_CHAT_FN_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface Window {
  // Firebase App Check debug-mode flag, read by the App Check SDK — not
  // declared in lib.dom.d.ts since it's a Firebase-only global.
  FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string
}
