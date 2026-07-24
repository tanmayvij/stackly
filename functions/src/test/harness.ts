// Shared harness for the backend's framework-free tests. A suite is a list of
// [name, fn] tuples; fn may be sync or async (async lets the emulator suites
// await Firestore). `main` runs one suite as a standalone script — used by the
// pure `*.test.ts` files, which self-run on `node lib/.../foo.test.js` and exit
// non-zero on the first failure. `runSuite` runs a suite WITHOUT exiting, so an
// aggregator (the emulator runner) can run several suites in one process, reset
// state between tests, and report a single pass/fail summary at the end.

export type Test = [name: string, fn: () => void | Promise<void>];

// A named group of tests, exported by the emulator suites so the aggregator
// (run-emulator.ts) can run them all under one emulator boot.
export interface Suite {
  name: string;
  tests: Test[];
}

/**
 * Runs every test in a suite, printing TAP-style `ok - ` / `FAIL - ` lines.
 * Never throws and never exits — returns the failure count so a caller can
 * aggregate across suites.
 * @param {string} name The suite name (printed as a TAP comment).
 * @param {Test[]} tests The [name, fn] tuples to run.
 * @return {Promise<number>} The number of failed tests.
 */
export async function runSuite(name: string, tests: Test[]): Promise<number> {
  console.log(`# ${name}`);
  let failed = 0;
  for (const [testName, fn] of tests) {
    try {
      await fn();
      console.log(`ok - ${testName}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${testName}`);
      console.error(err);
    }
  }
  return failed;
}

/**
 * Runs one suite as a standalone script and exits non-zero if anything failed.
 * @param {string} name The suite name.
 * @param {Test[]} tests The [name, fn] tuples to run.
 * @return {Promise<void>} Resolves after the summary is printed (or exits).
 */
export async function main(name: string, tests: Test[]): Promise<void> {
  const failed = await runSuite(name, tests);
  if (failed > 0) {
    console.error(`${failed}/${tests.length} tests failed`);
    process.exit(1);
  }
  console.log(`all ${tests.length} tests passed`);
}
