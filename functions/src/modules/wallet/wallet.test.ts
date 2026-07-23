// Self-running unit tests for the pure billing math in wallet.service.ts. Run
// with plain Node (no framework): `node lib/modules/wallet/wallet.test.js`.
// Exits non-zero on the first failure. The ledger read/write paths
// (addTransaction dedup, getBalanceForUser) run inside Firestore transactions
// and belong in an emulator-backed test, not here.

import assert from "node:assert";
import {costForTokens} from "./wallet.service";
import {MODEL_PRICING} from "../../shared/config";

const GLM = "zai-org/GLM-5.2"; // 400 cents / 1M tokens
const FLASH = "deepseek-ai/DeepSeek-V4-Flash"; // 50 cents / 1M tokens
const GPT_OSS = "openai/gpt-oss-120b"; // 35 cents / 1M tokens

const TESTS: Array<[string, () => void]> = [
  [
    "one million tokens costs exactly the per-million price",
    () => {
      assert.equal(costForTokens(GPT_OSS, 1_000_000), 35);
      assert.equal(costForTokens(GLM, 1_000_000), 400);
      assert.equal(costForTokens(FLASH, 1_000_000), 50);
    },
  ],
  [
    "zero tokens costs zero",
    () => {
      assert.equal(costForTokens(GLM, 0), 0);
    },
  ],
  [
    "sub-penny usage is never free — always rounds up to 1 cent",
    () => {
      // 1 token on GLM = 0.0004 cents; must charge a whole cent.
      assert.equal(costForTokens(GLM, 1), 1);
      assert.equal(costForTokens(FLASH, 1), 1);
    },
  ],
  [
    "fractional cost rounds UP, never down",
    () => {
      // 2600 tokens on GLM = 2600/1e6 * 400 = 1.04 cents -> 2.
      assert.equal(costForTokens(GLM, 2600), 2);
      // 500001 tokens on FLASH = 25.00005 cents -> 26.
      assert.equal(costForTokens(FLASH, 500_001), 26);
    },
  ],
  [
    "an exact whole-cent cost is not over-charged",
    () => {
      // 2500 tokens on GLM = exactly 1.0 cent.
      assert.equal(costForTokens(GLM, 2500), 1);
      // 500000 tokens on FLASH = exactly 25 cents.
      assert.equal(costForTokens(FLASH, 500_000), 25);
    },
  ],
  [
    "every configured model is priced without throwing",
    () => {
      for (const {model, pricePerMillionTokensCents} of MODEL_PRICING) {
        assert.equal(
          costForTokens(model, 1_000_000),
          pricePerMillionTokensCents,
          model,
        );
      }
    },
  ],
  [
    "an unpriced model throws instead of billing zero",
    () => {
      assert.throws(() => costForTokens("no-such/model", 1_000_000));
    },
  ],
];

let failed = 0;
for (const [name, fn] of TESTS) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL - ${name}`);
    console.error(err);
  }
}
if (failed > 0) {
  console.error(`${failed}/${TESTS.length} tests failed`);
  process.exit(1);
}
console.log(`all ${TESTS.length} tests passed`);
