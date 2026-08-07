import assert from "node:assert/strict";
import test from "node:test";

import {
  createBrokerAuthChallenge,
  createBrokerAuthHello,
  createBrokerAuthProof,
  createBrokerAuthReady,
  createBrokerOperationAck,
  verifyBrokerAuthChallenge,
  verifyBrokerAuthProof,
  verifyBrokerAuthReady,
  verifyBrokerOperationAck
} from "../../plugins/codex/scripts/lib/broker-auth.mjs";

const AUTH = {
  brokerId: "broker-0123456789abcdef",
  generation: "generation-fedcba9876543210",
  capability: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
};

test("P6-BROKER-AUTH-001 mutually authenticates one broker generation", () => {
  const hello = createBrokerAuthHello(AUTH, {
    clientNonce: "BBBBBBBBBBBBBBBBBBBBBB",
    operation: "connect"
  });
  const challenge = createBrokerAuthChallenge(hello, AUTH, {
    serverNonce: "CCCCCCCCCCCCCCCCCCCCCC"
  });
  verifyBrokerAuthChallenge(challenge, hello, AUTH);
  const proof = createBrokerAuthProof(hello, challenge, AUTH);
  const seenNonces = new Set();
  verifyBrokerAuthProof(proof, hello, challenge, AUTH, { seenNonces, operation: "connect" });
  const ready = createBrokerAuthReady(proof, AUTH);
  verifyBrokerAuthReady(ready, proof, AUTH);
  const ack = createBrokerOperationAck(proof, AUTH, "stopped");
  verifyBrokerOperationAck(ack, proof, AUTH, "stopped");

  assert.throws(
    () => verifyBrokerAuthProof(proof, hello, challenge, AUTH, { seenNonces, operation: "connect" }),
    /authentication failed/
  );
});

test("P6-BROKER-AUTH-002 rejects the wrong capability or generation", () => {
  const hello = createBrokerAuthHello(AUTH, {
    clientNonce: "DDDDDDDDDDDDDDDDDDDDDD",
    operation: "shutdown"
  });
  const challenge = createBrokerAuthChallenge(hello, AUTH, {
    serverNonce: "EEEEEEEEEEEEEEEEEEEEEE"
  });

  assert.throws(
    () => verifyBrokerAuthChallenge(challenge, hello, { ...AUTH, capability: "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF" }),
    /authentication failed/
  );
  assert.throws(
    () => verifyBrokerAuthChallenge(challenge, hello, { ...AUTH, generation: "generation-0000000000000000" }),
    /authentication failed/
  );
});

test("P6-BROKER-AUTH-003 binds the operation and rejects malformed values", () => {
  const hello = createBrokerAuthHello(AUTH, {
    clientNonce: "GGGGGGGGGGGGGGGGGGGGGG",
    operation: "connect"
  });
  const challenge = createBrokerAuthChallenge(hello, AUTH, {
    serverNonce: "HHHHHHHHHHHHHHHHHHHHHH"
  });
  const proof = createBrokerAuthProof(hello, challenge, AUTH);

  assert.throws(
    () => verifyBrokerAuthProof(proof, hello, challenge, AUTH, { operation: "shutdown" }),
    /authentication failed/
  );
  assert.throws(
    () => createBrokerAuthChallenge({ ...hello, params: { ...hello.params, clientNonce: "not valid" } }, AUTH),
    /authentication failed/
  );
});
