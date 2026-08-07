import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkerControllerDescriptor,
  validateWorkerControllerDescriptor
} from "../../plugins/codex/scripts/lib/worker-control.mjs";

test("P6-WORKER-CONTROL-001 persists only the worker identity and generation", () => {
  const descriptor = createWorkerControllerDescriptor({
    workerId: "worker-0123456789abcdef",
    generation: "generation-fedcba9876543210"
  });
  assert.deepEqual(Object.keys(descriptor).sort(), ["generation", "version", "workerId"]);
  assert.equal(validateWorkerControllerDescriptor(descriptor), descriptor);
  assert.throws(
    () => validateWorkerControllerDescriptor({ ...descriptor, pid: 1234 }),
    /worker controller/
  );
  assert.throws(
    () => validateWorkerControllerDescriptor({ ...descriptor, workerId: "../outside" }),
    /worker controller/
  );
});
