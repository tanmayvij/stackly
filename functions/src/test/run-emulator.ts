// Aggregator for the Admin-SDK emulator suites. Booting the emulator once and
// running every suite in a single process (rather than one boot per file) keeps
// the run fast. Firestore + Storage are cleared before each test so tests never
// leak state into one another. Exits non-zero if any test fails.
//
// Run via: `firebase emulators:exec --only firestore,storage,auth \
//   "node lib/test/run-emulator.js && node lib/test/firestore.rules.test.js"`.
// (The rules suite uses a different SDK and manages its own lifecycle, so it
// runs as a separate script under the same emulator boot.)

import {Suite} from "./harness";
import {initTestApp, clearFirestore, clearStorage} from "./emulator";
import {suite as walletSuite} from "../modules/wallet/wallet.service.emulator.test";
import {suite as messagesSuite} from "../modules/builder/messages/messages.service.emulator.test";
import {suite as versionsSuite} from "../modules/builder/versions/versions.service.emulator.test";

const SUITES: Suite[] = [walletSuite, messagesSuite, versionsSuite];

/**
 * Runs every emulator suite, resetting emulator state before each test.
 * @return {Promise<void>} Resolves after the summary prints (or exits non-zero).
 */
async function run(): Promise<void> {
  initTestApp();
  let failed = 0;
  let total = 0;
  for (const suite of SUITES) {
    console.log(`# ${suite.name}`);
    for (const [name, fn] of suite.tests) {
      total += 1;
      try {
        await clearFirestore();
        await clearStorage();
        await fn();
        console.log(`ok - ${name}`);
      } catch (err) {
        failed += 1;
        console.error(`FAIL - ${name}`);
        console.error(err);
      }
    }
  }
  if (failed > 0) {
    console.error(`${failed}/${total} emulator tests failed`);
    process.exit(1);
  }
  console.log(`all ${total} emulator tests passed`);
}

run().catch((err) => {
  console.error("emulator test runner crashed");
  console.error(err);
  process.exit(1);
});
