import { parentPort, workerData } from 'node:worker_threads';
import { PatchPoolStore } from '../src/store.js';

const store = PatchPoolStore.open(workerData.path);
try {
  const barrier = new Int32Array(workerData.barrier);
  const waiting = Atomics.add(barrier, 0, 1) + 1;
  Atomics.notify(barrier, 0);
  while (Atomics.load(barrier, 0) < 2) Atomics.wait(barrier, 0, waiting - 1);
  const claim = store.claimIssue({ repoId: workerData.repoId, issueNumber: 7, workerId: workerData.workerId });
  parentPort.postMessage({ ok: true, id: claim.id });
} catch (error) {
  parentPort.postMessage({ ok: false, code: error.code, message: error.message });
} finally {
  store.close();
}
