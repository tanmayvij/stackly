// Global bootstrap: initializes the Admin SDK and sets the deploy-wide
// function options. Imported for its side effects as the first line of
// index.ts, so initializeApp() runs before any handler module loads.

import {setGlobalOptions} from "firebase-functions";
import {initializeApp} from "firebase-admin/app";

initializeApp();
setGlobalOptions({maxInstances: 10, region: "asia-east2"});
