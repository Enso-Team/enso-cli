// Commits `count` transactions through the real runner storage, then exits without closing the database, so the
// syncs counted by the preloaded interposer are the ones commits issue (no close-time checkpoint).
import { realpathSync } from "node:fs";
import { RunnerEngine } from "../../src/runner/engine.js";
import { FakeProvider } from "../../src/runner/provider.js";
import { RunnerStorage } from "../../src/runner/storage.js";

const [directory, count] = [process.argv[2], Number(process.argv[3])];
const storage = new RunnerStorage(directory);
storage.acquire();
const engine = new RunnerEngine(storage, new FakeProvider(), { autoDispatch: false });
const binding = { bridgeUrl: "http://127.0.0.1:17650", workingDirectory: realpathSync(directory), canvasTarget: {
  vaultID: "11111111-1111-4111-8111-111111111111", canvasID: "22222222-2222-4222-8222-222222222222"
} };
for (let n = 0; n < count; n++) engine.createSession({ binding });
process.exit(0);
