// Fail fast on missing build-time configuration. This module is imported FIRST
// in main.ts so it runs as a side effect *before* firebase.ts initializes —
// turning a cryptic deep-in-the-SDK failure into a clear boot error that names
// exactly which VITE_ variables are absent.
//
// Keep REQUIRED_ENV_VARS in sync with .env.example and env.d.ts (see the
// "Env/secret example sync" memory). Optional vars (VITE_USE_EMULATORS,
// VITE_CHAT_FN_URL) are deliberately excluded.

const REQUIRED_ENV_VARS = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_APP_ID',
  'VITE_FUNCTIONS_REGION',
  'VITE_RECAPTCHA_SITE_KEY',
  'VITE_STRIPE_PUBLISHABLE_KEY',
  'VITE_GHL_CLIENT_ID',
  'VITE_GHL_REDIRECT_URI',
  'VITE_GHL_SCOPES',
  'VITE_GHL_VERSION_ID',
] as const

// A present-but-blank value (the .env.example default) counts as missing.
const missing = REQUIRED_ENV_VARS.filter((key) => !import.meta.env[key])

if (missing.length > 0) {
  throw new Error(
    `Missing required environment variable(s): ${missing.join(', ')}. ` +
      'Copy .env.example to .env.local and fill in the values.',
  )
}
