# Stackly

**Stackly is an AI app builder for HighLevel (GoHighLevel / LeadConnector).** You describe the app you want in plain English, and Stackly's AI generates a working mini React app that talks to your HighLevel sub-account — its contacts, conversations, and calendars — through a secure server-side proxy. You can chat with the AI to iterate, edit the code by hand in an in-browser Monaco editor, preview the running app instantly (bundled entirely in the browser with `esbuild-wasm`), and roll back to any previous version. Usage is metered against a prepaid wallet topped up with Stripe.

- **Live app:** https://stackly.site
- **Cloud Functions base URL:** https://us-central1-ghl-builder-161d7.cloudfunctions.net
  - e.g. the streaming builder endpoint is `…/chat`, the runtime GHL proxy is `…/ghlProxy`, health check is `…/health`.

---

## Table of contents

1. [What Stackly does](#what-stackly-does)
2. [Tech stack](#tech-stack)
3. [Repository structure](#repository-structure)
4. [How it works](#how-it-works)
5. [Local setup](#local-setup)
6. [GHL OAuth setup](#ghl-oauth-setup)
7. [Deployment notes](#deployment-notes)
8. [Getting started with the app](#getting-started-with-the-app)
9. [Architecture decisions](#architecture-decisions)
10. [Future improvements](#future-improvements)
11. [Demo video](#demo-video)

---

## What Stackly does

Stackly is a monorepo containing a Vue 3 single-page app, a Firebase Cloud Functions backend, and the Firebase project configuration (Firestore rules, Storage rules, indexes, emulators, hosting, and CI/CD) that ties them together.

The core loop:

1. **Sign in** with email/password (with an email-verification step) or Google SSO.
2. **Load your wallet** with Stripe (sandbox mode — test cards only).
3. **Connect your HighLevel account** via OAuth2.
4. **Create a project** from a prompt — the AI names and scaffolds it.
5. **Build with AI chat** — each turn streams generated code into a live in-browser preview, and every change is committed as an immutable version you can diff or restore.
6. **Run against real HighLevel data** — generated apps call HighLevel's Contacts, Conversations, and Calendars APIs through Stackly's server-side proxy, so a GHL access token never reaches the browser.

---

## Tech stack

| Area | Technology |
|---|---|
| Frontend framework | Vue 3 (Composition API, `<script setup>`), TypeScript |
| Build tool | Vite 8 |
| UI | shadcn-vue (New York style) on reka-ui, Tailwind CSS v4, Lucide icons |
| State | Pinia (setup stores) |
| Routing | Vue Router 5 |
| Code editor | Monaco (`@guolao/vue-monaco-editor`) |
| In-browser bundler | `esbuild-wasm` (+ `esm.sh` CDN import maps) |
| Payments (client) | `@stripe/stripe-js` (hosted PaymentElement) |
| Backend | Firebase Cloud Functions **v2** (`firebase-functions@7`), Node 24, TypeScript |
| Data | Cloud Firestore |
| File storage | Cloud Storage (content-addressed blobs) |
| Auth | Firebase Authentication |
| Payments (server) | `stripe` SDK |
| LLM client | `openai` SDK pointed at an OpenAI-compatible gateway (DeepInfra) |
| Hosting / CDN | Firebase Hosting (custom domain `stackly.site`) |
| CI/CD | GitHub Actions → `firebase deploy` |

The underlying Firebase project id is **`ghl-builder-161d7`** (the public product name is "Stackly").

---

## Repository structure

```
stackly/
├─ package.json            # root: `npm run dev` orchestrates the whole stack via concurrently
├─ firebase.json           # hosting, functions, firestore, storage, emulator config
├─ .firebaserc             # default project → ghl-builder-161d7
├─ firestore.rules         # per-user, default-deny security model
├─ firestore.indexes.json  # composite index for the projects list query
├─ storage.rules           # per-user content-addressed blob access
├─ .github/workflows/
│  └─ deploy.yml            # build (frontend ∥ functions) → deploy on push to master
│
├─ functions/              # Cloud Functions backend (TypeScript → lib/)
│  ├─ .secret.example       # secret names required by the backend
│  └─ src/
│     ├─ index.ts           # exports every function
│     ├─ app.ts             # initializeApp + setGlobalOptions
│     ├─ config.ts          # secret definitions, model pricing, thresholds
│     ├─ wallet.ts          # Stripe top-ups + the billing ledger
│     ├─ ghl.ts             # HighLevel OAuth token exchange
│     ├─ ghl-proxy.ts       # runtime GHL API proxy for generated apps
│     ├─ preview-token.ts   # short-lived HMAC tokens for the preview iframe
│     ├─ projects.ts        # createProject (AI names/describes the app)
│     ├─ chat.ts            # SSE-streaming builder chat (one turn = one version)
│     ├─ openai.ts          # OpenAI-compatible LLM client
│     ├─ repo.ts            # server-side "mini-git" (blobs + versions)
│     ├─ messages.ts        # chat transcript + per-project generation lock
│     ├─ llm-parser.ts      # incremental parser for the model's streamed output
│     ├─ prompt.ts, ghl-docs.ts  # prompt assembly + injected GHL API docs
│     └─ test/              # node test files (llm-parser, wallet, messages)
│
└─ stackly-frontend/       # Vue SPA
   ├─ .env.example
   └─ src/
      ├─ main.ts, App.vue
      ├─ views/             # AuthView, VerifyEmailView, DashboardView,
      │                     # LeadConnectorOAuthView, BuilderView, PreviewView, …
      ├─ router/index.ts    # routes + auth/verification guards
      ├─ stores/            # auth, wallet, ghl, projects, builder, ui (Pinia)
      ├─ lib/               # firebase, callables, chat-stream (SSE), builder-repo,
      │                     # chat-repo, preview-bundler, preview-html, models, …
      ├─ composables/       # useTheme, usePreview
      ├─ layouts/           # AppLayout, AuthLayout
      └─ components/        # ui/ (shadcn), builder/, projects/, ghl/, wallet/, …
```

---

## How it works

**Authentication.** Email/password registration sends a verification email; a router guard forces unverified users to `/verify-email` and away from the app until they confirm. Google SSO accounts arrive already verified and skip that gate. Auth state is held in a Pinia store and gates all protected routes.

**Wallet & billing.** Balances are integer **cents** and are only ever computed on the server. The wallet is a ledger: `wallets/{uid}/transactions/{id}` holds `CREDIT` (Stripe top-ups) and `DEBIT` (LLM usage) entries, and `getCurrentBalance` sums the whole subcollection — there is no stored balance field. Writes go through a single deduplicated path keyed by `refId` (the Stripe PaymentIntent id for credits, `chat:{requestId}` / `compact:{requestId}` for debits), so retries never double-count. Top-ups use Stripe's hosted PaymentElement (`createTopUpIntent` → confirm on the client → `confirmTopUp` verifies with Stripe and credits `amount_received`). Ledger docs are unreadable by clients — the balance only ever reaches the UI through the callable.

**HighLevel OAuth.** `exchangeGhlCode` swaps the OAuth authorization code for Location-scoped tokens and stores them in `ghlConnections/{uid}` — server-side only; Firestore rules deny all client access to tokens. Only sub-account (Location) installs are supported; agency installs are rejected. A friendly location name is fetched (via the `locations.readonly` scope) purely for UX.

**The AI builder ("mini-git").** A project's files are stored like a tiny content-addressed git: file **bytes** live in Cloud Storage keyed by their `sha256`; each **version** is an immutable Firestore document holding a flat `path → sha256` manifest; the project doc tracks `headVersion` (the current state). Unchanged files across versions share the same blob, so history is cheap, diffs are pure hash comparison, and there is no working-tree write contention. An AI turn is exactly one version; manual saves and restores each append a version too.

**Streaming chat.** Callable functions can't stream, so the builder chat is a raw HTTP endpoint (`chat`) that emits Server-Sent Events. One request = one generation turn: verify the ID token → balance gate (HTTP 402 if too low) → acquire a per-project lock (HTTP 409 if busy) → optionally compact old history → stream the LLM completion, parsing it incrementally into typed SSE events (`reply-delta`, `file-delta`, `question`, `version`, `done`, …) → atomically commit a new version + assistant message and debit the wallet. A client disconnect aborts the upstream call and records an interrupted turn **free of charge**.

**In-browser preview & the GHL proxy.** Generated apps are bundled in the browser with `esbuild-wasm` (bare imports resolved to `esm.sh`) and rendered in an iframe via `srcdoc`. When an app needs live HighLevel data it calls the `ghlProxy` function with a short-lived HMAC preview token (minted by `mintPreviewToken`). The proxy validates the token, pins the connected `locationId`, refreshes the access token when near expiry, forwards to HighLevel, and returns the response — so generated code calls the CRM without ever holding a token.

---

## Local setup

### Prerequisites

- **Node.js 24** (the functions runtime; the frontend accepts `^22.18.0 || >=24.12.0`).
- **Java JDK** (required by the Firestore emulator).
- **Firebase CLI** (`npm i -g firebase-tools`) — see [Deployment notes](#local-firebase-cli-setup).

### 1. Install dependencies (three places)

Dependencies are **not** hoisted — you must install at the repo root **and** inside both packages:

```bash
npm install                       # repo root (concurrently)
npm --prefix stackly-frontend install
npm --prefix functions install
```

### 2. Configure environment

- **Frontend:** copy `stackly-frontend/.env.example` to `stackly-frontend/.env.local` and fill in the values (Firebase web config, Stripe publishable key, GHL client id/redirect/scopes). Set `VITE_USE_EMULATORS=true` to route auth + functions + Firestore + Storage to the local emulators.
- **Backend:** copy `functions/.secret.example` to `functions/.secret.local` and fill in the secret values (the emulator loads them automatically).

### 3. Run everything with one command

From the repo root:

```bash
npm run dev
```

This runs a `concurrently` process (`-n backend,frontend -k`) that starts, in parallel:

- **backend** — `npm --prefix functions run serve`, which builds the functions and launches the Firebase emulators.
- **frontend** — `npm --prefix stackly-frontend run dev`, the Vite dev server on **http://localhost:5173**.

The `-k` flag means if either process exits, the other is killed too.

**Emulators started** (`firebase emulators:start --only functions,firestore,auth,storage`):

| Emulator | Port |
|---|---|
| Authentication | 9099 |
| Cloud Functions | 5001 |
| Firestore | 8080 |
| Cloud Storage | 9199 |
| Emulator UI | enabled (auto-assigned, usually 4000) |

> Note: the Hosting emulator is intentionally **not** run — the Vite dev server serves the frontend during development. `singleProjectMode` is on so all emulators share the one project id.

---

## GHL OAuth setup

Stackly authenticates with HighLevel through a Marketplace app:

1. In a **GHL Developer account** at [marketplace.gohighlevel.com](https://marketplace.gohighlevel.com), an app named **"Stackly"** was created.
2. It was granted the scopes for the three API sets Stackly uses:
   - **Conversations**
   - **Contacts**
   - **Calendars**
   - plus **`locations.readonly`**, so the app can fetch the connected location's name for a friendlier UX.
3. Two **redirect URIs** were registered:
   - `https://stackly.site/leadconnector/oauth` (production)
   - `http://localhost:5173/leadconnector/oauth` (local development)
4. A **Sandbox GHL account** was created for testing without touching a real sub-account: [marketplace.gohighlevel.com/sandbox](https://marketplace.gohighlevel.com/sandbox).

The app's client id and secret become the `GHL_CLIENT_ID` / `GHL_CLIENT_SECRET` backend secrets; the client id, redirect URI, and scopes are also mirrored into the frontend env (`VITE_GHL_CLIENT_ID`, `VITE_GHL_REDIRECT_URI`, `VITE_GHL_SCOPES`).

> HighLevel's token endpoint (`https://services.leadconnectorhq.com/oauth/token`) expects **camelCase** form params (`clientId`, `clientSecret`, `grantType`, `redirectUri`, `refreshToken`), not the OAuth2-standard snake_case — worth remembering if you touch the exchange code. All tokens are minted with `userType: "Location"`.

---

## Deployment notes

Several external components are wired together for the production deployment.

### 1. Stripe

A **sandbox Stripe account** is used. The **secret key** lives in Firebase secrets (`STRIPE_SECRET_KEY`, an `sk_test_…` key) and the **publishable key** is in the Vue app env (`VITE_STRIPE_PUBLISHABLE_KEY`). Top-ups are created and confirmed through the `createTopUpIntent` / `confirmTopUp` callables; there is no webhook endpoint — confirmation is verified by retrieving the PaymentIntent from Stripe on demand.

### 2. Firebase project setup

A new Firebase project was created from scratch and:

- **Upgraded to the Blaze plan** — the free Spark plan does not support Cloud Functions.
- **Enabled** Hosting, Authentication, Cloud Functions, Firestore, and Cloud Storage.
- **Firestore and Storage security rules are managed entirely in code** (`firestore.rules`, `firestore.indexes.json`, `storage.rules`) and deployed from the repo — nothing is hand-edited in the console.
- **Disabled email-enumeration protection** in Auth. This is a deliberate trade-off for a smoother onboarding flow (one fewer step during sign-up).
- **Custom domains** were added — `stackly.site` for Hosting, and a domain for Authentication emails. The **sender email** for all auth emails was changed to `noreply@stackly.site` and the **sender name** to **Stackly**.
- A **service account** was created for GitHub Actions to authenticate to Firebase for automated deploys.

#### Local Firebase CLI setup

```bash
npm install -g firebase-tools
firebase login          # grants the CLI access for deploys and emulator setup
```

The active project is pinned in `.firebaserc` (`ghl-builder-161d7`). With the CLI authenticated you can run the emulators locally and, if needed, deploy manually.

### 3. DeepInfra (LLM provider)

The models are served by **DeepInfra**. After signing up and recharging the wallet for initial use, an API key was generated and stored as the `OPENAI_API_KEY` secret; DeepInfra is reached through its **OpenAI-compatible API**, with the endpoint set in the `OPENAI_BASE_URL` secret. The backend uses the standard `openai` SDK pointed at that base URL. Configured models and per-million-token pricing (in cents) live in `functions/src/config.ts`:

| Model | ¢ / 1M tokens | Context window |
|---|---|---|
| `zai-org/GLM-5.2` (default) | 400 | 1,000,000 |
| `moonshotai/Kimi-K2.7-Code` | 450 | 256,000 |
| `deepseek-ai/DeepSeek-V4-Flash` | 50 | 1,000,000 |
| `openai/gpt-oss-120b` | 35 | 128,000 |

`DeepSeek-V4-Flash` doubles as the cheap "flash" model used for project naming and history compaction.

### 4. GitHub Actions (automated deploys)

This is the important part. The repository has a GitHub Action ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)) that **deploys to Firebase automatically on every push to `master`**.

- There is currently **one production environment** — no separate UAT/Staging. Adding multiple environments is a straightforward future enhancement.
- The workflow uses two repository secrets:
  - **`FIREBASE_SERVICE_ACCOUNT_GHL_BUILDER_161D7`** — the Google service account JSON used to authenticate the deploy.
  - **`VITE_ENV`** — the entire frontend `.env` file. It is written out at build time and injected into the Vite build. **Any change a developer makes to their local `.env.local` must be mirrored into the `VITE_ENV` GitHub secret** (with the appropriate production values), or production will build with stale config.
- **Pipeline shape:** the frontend and backend **build in parallel** as two independent jobs (`build_frontend`, `prepare_functions`), each uploading its output as an artifact. A final **`deploy`** job downloads both artifacts, installs production-only function dependencies, and runs a single `firebase deploy` that ships Hosting, Functions, Firestore rules + indexes, and Storage rules together.

> The full list of environment variables is documented in `functions/.secret.example` (backend) and `stackly-frontend/.env.example` (frontend).

---

## Getting started with the app

1. **Sign in.** Open the app and continue with an **email and password** (which triggers an email-verification flow) or with **Google SSO**.

2. **Complete the two prerequisites** on the dashboard:

   **a. Load your Stackly wallet.** Payments run through Stripe. It is currently in **sandbox mode**, so use any Stripe **test card** — no real money moves. For example:

   | Card number | Brand | Behavior |
   |---|---|---|
   | `4242 4242 4242 4242` | Visa | Succeeds immediately |
   | `4000 0025 0000 3155` | Visa | Requires 3-D Secure authentication |

   Use any future expiry date, any 3-digit CVC, and any postal code.

   **b. Connect your HighLevel account** via the OAuth2 flow (choose a single **sub-account / location** on the HighLevel authorization screen — agency installs aren't supported).

3. **Build.** Create a project from a prompt and start chatting with the AI to build your app. Watch the code stream into the live preview, edit files directly when you want to, and restore any earlier version from the history.

---

## Architecture decisions

- **Content-addressed "mini-git" for project files.** File bytes are stored once in Cloud Storage keyed by their `sha256`, versions are immutable path→hash manifests, and `headVersion` is the single source of truth. Unchanged files are shared across versions for free, so deep history is cheap and restores upload zero bytes. Append-only, immutable history removes write contention. Because a version is written once and never mutated, a manual edit and an AI edit can never conflict each other. Each just appends. Diffing is a pure set/hash comparison; content is only fetched for line-level views.
- **The balance is a ledger sum, never a mutable counter.** All wallet writes flow through one path deduplicated on `refId` inside a Firestore transaction, so retried Stripe polls and repeated chat debits are idempotent and the balance can always be re-derived from the transaction log.
- **Money and secrets never leak to the client.** Token/cost data is backend-only; the ledger is unreadable by clients; the balance surfaces solely through the `getCurrentBalance` callable; and HighLevel tokens live server-side, reachable only through the proxy.
- **SSE over raw HTTP for real streaming.** Callables buffer, so the builder chat is an `onRequest` function that hits the direct Cloud Functions URL (never a Hosting rewrite, which would buffer), with heartbeats and no-buffering headers so tokens reach the UI as they're generated.
- **Firestore is the source of truth; the stream is a render-only overlay.** Finished turns are reconciled from the `messages` listener, so a dropped connection, a second tab, or a refresh always converges on the same state — the stream just makes it feel live.
- **Honest billing on failure.** Client disconnects and internal timeouts persist an interrupted/failed turn and charge nothing; only clean, committed generations debit the wallet.
- **Default-deny security, enforced by code.** Firestore and Storage rules deny everything by default and grant only per-user (`request.auth.uid == uid`) access to owned subcollections; project creation and chat writes are Admin-SDK-only. Rules are versioned in the repo and deployed by CI.
- **A server-side GHL proxy with a scoped, expiring capability.** Generated apps get a 30-minute HMAC preview token, not a CRM token; the proxy enforces a path allowlist (contacts/conversations/calendars), pins the location id, and transparently refreshes tokens.
- **Context stays affordable via automatic compaction.** When a run approaches the model's context window, older turns are summarized by the cheap flash model so long conversations keep working without unbounded prompt growth.
- **Chat lock** When a generation starts, a state lock is applied on the project, which means a user cannot exploit the API by spinning up multiple parallel generations for a single project. This also prevents race conditions and double-billing for the same request. 

---

## Future improvements

- **Richer billing** — saved cards, auto-recharge, payment history, and downloadable invoices.
- **Faster balance calculation** — today `getCurrentBalance` aggregates across **all** of a user's ledger docs. Carrying a balance forward at each month's close would make the running total cheap to compute.
- **Team management and role-based access control** within a team.
- **Git integration** — let users sync their generated code with their own remote (GitHub, etc.).
- **Scope-aware AI** — allow users to grant a limited set of GHL scopes and have the AI detect when it lacks the right scope (or hits a 401) and tell the user, rather than failing opaquely.

---

## Demo video

A video walkthrough of the project:

> 🎥 [YouTube](https://youtu.be/xnOFESsABvQ)
