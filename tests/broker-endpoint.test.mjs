import test from "node:test";
import assert from "node:assert/strict";

import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";

test("createBrokerEndpoint uses named pipes on Windows", () => {
  const endpoint = createBrokerEndpoint("C:\\\\Temp\\\\cxc-12345");
  assert.equal(endpoint, "pipe:\\\\.\\pipe\\cxc-12345-codex-app-server");
  assert.deepEqual(parseBrokerEndpoint(endpoint), {
    kind: "pipe",
    path: "\\\\.\\pipe\\cxc-12345-codex-app-server"
  });
});

test("parseBrokerEndpoint rejects unsupported endpoint transports", () => {
  assert.throws(
    () => parseBrokerEndpoint("unix:/tmp/cxc-12345/broker.sock"),
    /Unsupported broker endpoint/
  );
});
