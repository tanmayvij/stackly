// Emulator-backed tests for firestore.rules. Projects are read/updated/
// soft-deleted entirely client-side (only createProject is a Cloud Function),
// so the CRUD + pagination contract lives in the rules — this is where it is
// verified. Uses @firebase/rules-unit-testing (client SDK) against the
// Firestore emulator. Runs as its own script under the same emulator boot as
// run-emulator.ts:
//   node lib/test/run-emulator.js && node lib/test/firestore.rules.test.js

import {readFileSync} from "node:fs";
import path from "node:path";
import {
  RulesTestEnvironment,
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import {Test, runSuite} from "./harness";

const OWNER = "owner-uid";
const OTHER = "other-uid";
const PROJECTS = `users/${OWNER}/projects`;
const PROJECT = `${PROJECTS}/p1`;

/**
 * Parses the emulator host:port that `emulators:exec` exports.
 * @return {{host: string, port: number}} The Firestore emulator address.
 */
function emulatorAddress(): {host: string; port: number} {
  const raw = process.env.FIRESTORE_EMULATOR_HOST;
  if (!raw) {
    throw new Error(
      "FIRESTORE_EMULATOR_HOST is not set — run via `firebase emulators:exec`.",
    );
  }
  const parts = raw.split(":");
  return {host: parts[0] ?? "127.0.0.1", port: Number(parts[1] ?? "8080")};
}

/**
 * A baseline project document (owner's, not deleted).
 * @return {Record<string, unknown>} The seed data.
 */
function baseProject(): Record<string, unknown> {
  return {
    name: "Proj", description: "", modelId: "zai-org/GLM-5.2",
    deleted: false, headVersion: 2, initialPrompt: "build me a thing",
    lastMessageSeq: 4, createdAt: serverTimestamp(),
    lastModified: serverTimestamp(),
  };
}

/**
 * Builds every rules test, closing over the initialized environment.
 * @param {RulesTestEnvironment} env The test environment.
 * @return {Test[]} The suite.
 */
function buildTests(env: RulesTestEnvironment): Test[] {
  const owner = () => env.authenticatedContext(OWNER).firestore();
  const other = () => env.authenticatedContext(OTHER).firestore();
  const anon = () => env.unauthenticatedContext().firestore();

  /**
   * Clears data and seeds one project doc via a rules-bypassing context.
   * @param {Record<string, unknown>} [data] The project data to seed.
   * @return {Promise<void>} Resolves once seeded.
   */
  const reset = async (data = baseProject()): Promise<void> => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), PROJECT), data);
    });
  };

  return [
    [
      "owner reads their own non-deleted project; others and anon cannot",
      async () => {
        await reset();
        await assertSucceeds(getDoc(doc(owner(), PROJECT)));
        await assertFails(getDoc(doc(other(), PROJECT)));
        await assertFails(getDoc(doc(anon(), PROJECT)));
      },
    ],
    [
      "a soft-deleted project is not readable even by its owner",
      async () => {
        await reset({...baseProject(), deleted: true});
        await assertFails(getDoc(doc(owner(), PROJECT)));
      },
    ],
    [
      "clients can never create a project (only the Cloud Function can)",
      async () => {
        await env.clearFirestore();
        await assertFails(
          setDoc(doc(owner(), `${PROJECTS}/new`), baseProject()),
        );
      },
    ],
    [
      "owner may soft-delete via update with a server lastModified",
      async () => {
        await reset();
        await assertSucceeds(
          updateDoc(doc(owner(), PROJECT), {
            deleted: true, lastModified: serverTimestamp(),
          }),
        );
      },
    ],
    [
      "update is rejected when createdAt or modelId change",
      async () => {
        await reset();
        await assertFails(
          updateDoc(doc(owner(), PROJECT), {
            createdAt: new Date(0), lastModified: serverTimestamp(),
          }),
        );
        await reset();
        await assertFails(
          updateDoc(doc(owner(), PROJECT), {
            modelId: "openai/gpt-oss-120b", lastModified: serverTimestamp(),
          }),
        );
      },
    ],
    [
      "headVersion may advance but never regress",
      async () => {
        await reset();
        await assertSucceeds(
          updateDoc(doc(owner(), PROJECT), {
            headVersion: 3, lastModified: serverTimestamp(),
          }),
        );
        await reset();
        await assertFails(
          updateDoc(doc(owner(), PROJECT), {
            headVersion: 1, lastModified: serverTimestamp(),
          }),
        );
      },
    ],
    [
      "update requires lastModified to equal server time",
      async () => {
        await reset();
        await assertFails(
          updateDoc(doc(owner(), PROJECT), {lastModified: new Date(0)}),
        );
      },
    ],
    [
      "clients cannot change server-managed initialPrompt or lastMessageSeq",
      async () => {
        await reset();
        await assertFails(
          updateDoc(doc(owner(), PROJECT), {
            initialPrompt: "hacked", lastModified: serverTimestamp(),
          }),
        );
        await reset();
        await assertFails(
          updateDoc(doc(owner(), PROJECT), {
            lastMessageSeq: 99, lastModified: serverTimestamp(),
          }),
        );
      },
    ],
    [
      "hard delete of a project is always denied",
      async () => {
        await reset();
        await assertFails(deleteDoc(doc(owner(), PROJECT)));
      },
    ],
    [
      "the paginated listing query (deleted==false, ordered, limited) is allowed",
      async () => {
        await reset();
        const q = query(
          collection(owner(), PROJECTS),
          where("deleted", "==", false),
          orderBy("lastModified", "desc"),
          limit(10),
        );
        await assertSucceeds(getDocs(q));
      },
    ],
    [
      "a listing without the deleted==false filter is denied",
      async () => {
        await reset();
        const q = query(
          collection(owner(), PROJECTS),
          orderBy("lastModified", "desc"),
          limit(10),
        );
        await assertFails(getDocs(q));
      },
    ],
    [
      "versions are owner-creatable with a valid shape and immutable after",
      async () => {
        await reset();
        const vpath = `${PROJECT}/versions/1`;
        await assertSucceeds(
          setDoc(doc(owner(), vpath), {
            n: 1, title: "v1", tree: {}, createdAt: serverTimestamp(),
          }),
        );
        await env.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), `${PROJECT}/versions/2`), {
            n: 2, title: "v2", tree: {}, createdAt: serverTimestamp(),
          });
        });
        await assertFails(
          updateDoc(doc(owner(), `${PROJECT}/versions/2`), {title: "x"}),
        );
        await assertFails(deleteDoc(doc(owner(), `${PROJECT}/versions/2`)));
        await assertSucceeds(getDoc(doc(owner(), `${PROJECT}/versions/2`)));
        await assertFails(getDoc(doc(other(), `${PROJECT}/versions/2`)));
      },
    ],
    [
      "messages are owner-readable but never client-writable",
      async () => {
        await reset();
        await env.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), `${PROJECT}/messages/m1`), {
            kind: "chat", role: "user", seq: 1, content: "hi",
          });
        });
        await assertSucceeds(getDoc(doc(owner(), `${PROJECT}/messages/m1`)));
        await assertFails(getDoc(doc(other(), `${PROJECT}/messages/m1`)));
        await assertFails(
          setDoc(doc(owner(), `${PROJECT}/messages/m2`), {content: "x"}),
        );
      },
    ],
    [
      "wallets are entirely off-limits to clients",
      async () => {
        await env.clearFirestore();
        await assertFails(getDoc(doc(owner(), `wallets/${OWNER}`)));
        await assertFails(
          setDoc(doc(owner(), `wallets/${OWNER}`), {balanceCents: 999}),
        );
      },
    ],
    [
      "ghlConnections are entirely off-limits to clients",
      async () => {
        await env.clearFirestore();
        await assertFails(getDoc(doc(owner(), `ghlConnections/${OWNER}`)));
        await assertFails(
          setDoc(doc(owner(), `ghlConnections/${OWNER}`), {token: "x"}),
        );
      },
    ],
  ];
}

/**
 * Initializes the rules test environment, runs the suite, and exits.
 * @return {Promise<void>} Resolves after cleanup (or exits non-zero).
 */
async function run(): Promise<void> {
  const {host, port} = emulatorAddress();
  const env = await initializeTestEnvironment({
    projectId: "demo-stackly-rules",
    firestore: {
      rules: readFileSync(
        path.resolve(__dirname, "../../../firestore.rules"),
        "utf8",
      ),
      host,
      port,
    },
  });

  const failed = await runSuite("firestore.rules", buildTests(env));
  await env.cleanup();

  if (failed > 0) {
    console.error(`${failed} rules tests failed`);
    process.exit(1);
  }
  console.log("all rules tests passed");
}

run().catch((err) => {
  console.error("rules test runner crashed");
  console.error(err);
  process.exit(1);
});
