// Firebase function registry. Every deployed function is re-exported here
// by its exact name (the deployed identity: callable names + HTTP URLs),
// sourced from its module's controller. The bootstrap import runs first so
// initializeApp()/setGlobalOptions() are in effect before any handler loads.

import "./core/bootstrap";

// ops
export {health} from "./modules/ops/health.controller";

// wallet
export {
  getCurrentBalance,
  createTopUpIntent,
  confirmTopUp,
} from "./modules/wallet/wallet.controller";

// ghl
export {
  exchangeGhlCode,
  getGhlConnection,
  disconnectGhl,
} from "./modules/ghl/ghl.controller";
export {ghlProxy} from "./modules/ghl/proxy.controller";

// projects
export {createProject} from "./modules/projects/projects.controller";

// builder (AI code-generation chat)
export {chat} from "./modules/builder/chat/chat.controller";

// preview
export {mintPreviewToken} from "./modules/preview/preview.controller";
