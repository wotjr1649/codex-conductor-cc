import assert from "node:assert/strict";
import test from "node:test";

import {
  createPosixBrokerDescriptor,
  validatePosixBrokerDescriptor
} from "../../plugins/codex/scripts/lib/broker-lifecycle.mjs";

const IDS = {
  sessionId: "broker-0123456789abcdef",
  generation: "generation-fedcba9876543210"
};

test("P6-BROKER-STATE-001 persists only validated non-secret identifiers", () => {
  const descriptor = createPosixBrokerDescriptor(process.cwd(), IDS, "starting");
  assert.deepEqual(Object.keys(descriptor).sort(), ["generation", "phase", "scopeId", "sessionId", "version"]);
  assert.equal(validatePosixBrokerDescriptor(process.cwd(), descriptor), descriptor);

  assert.throws(
    () => validatePosixBrokerDescriptor(process.cwd(), { ...descriptor, endpoint: "unix:/tmp/attacker.sock" }),
    /broker state/
  );
  assert.throws(
    () => validatePosixBrokerDescriptor(process.cwd(), { ...descriptor, scopeId: "0000000000000000" }),
    /broker state/
  );
});
