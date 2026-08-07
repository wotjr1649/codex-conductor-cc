import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN = /^[A-Za-z0-9._-]{1,128}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
const NONCE = /^[A-Za-z0-9_-]{22}$/;
const MAC = /^[a-f0-9]{64}$/;

function authenticationFailed() {
  return new Error("Broker authentication failed.");
}

function isAuth(auth) {
  return Boolean(
    auth &&
      TOKEN.test(auth.brokerId) &&
      TOKEN.test(auth.generation) &&
      CAPABILITY.test(auth.capability)
  );
}

function randomNonce() {
  return randomBytes(16).toString("base64url");
}

function hmac(auth, role, operation, clientNonce, serverNonce) {
  return createHmac("sha256", auth.capability)
    .update(
      `codex-conductor-broker-v1\0${role}\0${operation}\0${auth.brokerId}\0${auth.generation}\0${clientNonce}\0${serverNonce}`
    )
    .digest("hex");
}

function equalMac(left, right) {
  return MAC.test(left) && MAC.test(right) && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function isHello(message, auth) {
  const params = message?.params;
  return Boolean(
    message?.method === "broker/hello" &&
      isAuth(auth) &&
      params?.version === 1 &&
      TOKEN.test(params.operation) &&
      params.brokerId === auth.brokerId &&
      params.generation === auth.generation &&
      NONCE.test(params.clientNonce)
  );
}

function matchesTranscript(value, hello, auth) {
  const params = hello?.params;
  return Boolean(
    isHello(hello, auth) &&
      value?.version === 1 &&
      value.operation === params.operation &&
      value.brokerId === auth.brokerId &&
      value.generation === auth.generation &&
      value.clientNonce === params.clientNonce &&
      NONCE.test(value.serverNonce)
  );
}

export function createBrokerAuthHello(auth, { clientNonce = randomNonce(), operation = "connect" } = {}) {
  if (!isAuth(auth) || !NONCE.test(clientNonce) || !TOKEN.test(operation)) throw authenticationFailed();
  return {
    method: "broker/hello",
    params: {
      version: 1,
      operation,
      brokerId: auth.brokerId,
      generation: auth.generation,
      clientNonce
    }
  };
}

export function createBrokerAuthChallenge(hello, auth, { serverNonce = randomNonce() } = {}) {
  if (!isHello(hello, auth) || !NONCE.test(serverNonce)) throw authenticationFailed();
  const { operation, clientNonce } = hello.params;
  return {
    version: 1,
    operation,
    brokerId: auth.brokerId,
    generation: auth.generation,
    clientNonce,
    serverNonce,
    mac: hmac(auth, "server-challenge", operation, clientNonce, serverNonce)
  };
}

export function verifyBrokerAuthChallenge(challenge, hello, auth) {
  if (
    !matchesTranscript(challenge, hello, auth) ||
    !equalMac(
      challenge.mac,
      hmac(auth, "server-challenge", challenge.operation, challenge.clientNonce, challenge.serverNonce)
    )
  ) {
    throw authenticationFailed();
  }
  return true;
}

export function createBrokerAuthProof(hello, challenge, auth) {
  verifyBrokerAuthChallenge(challenge, hello, auth);
  return {
    method: "broker/auth",
    params: {
      version: 1,
      operation: challenge.operation,
      brokerId: auth.brokerId,
      generation: auth.generation,
      clientNonce: challenge.clientNonce,
      serverNonce: challenge.serverNonce,
      mac: hmac(auth, "client-proof", challenge.operation, challenge.clientNonce, challenge.serverNonce)
    }
  };
}

export function verifyBrokerAuthProof(proof, hello, challenge, auth, { operation, seenNonces = null } = {}) {
  const params = proof?.params;
  const replayKey = `${params?.clientNonce ?? ""}.${params?.serverNonce ?? ""}`;
  if (
    proof?.method !== "broker/auth" ||
    !matchesTranscript(params, hello, auth) ||
    !matchesTranscript(challenge, hello, auth) ||
    params.operation !== operation ||
    params.serverNonce !== challenge.serverNonce ||
    !equalMac(params.mac, hmac(auth, "client-proof", params.operation, params.clientNonce, params.serverNonce)) ||
    seenNonces?.has(replayKey)
  ) {
    throw authenticationFailed();
  }
  seenNonces?.add(replayKey);
  return true;
}

export function createBrokerAuthReady(proof, auth) {
  const params = proof?.params;
  if (!isAuth(auth) || proof?.method !== "broker/auth" || !NONCE.test(params?.clientNonce) || !NONCE.test(params?.serverNonce)) {
    throw authenticationFailed();
  }
  return {
    version: 1,
    operation: params.operation,
    brokerId: auth.brokerId,
    generation: auth.generation,
    clientNonce: params.clientNonce,
    serverNonce: params.serverNonce,
    ready: true,
    mac: hmac(auth, "server-ready", params.operation, params.clientNonce, params.serverNonce)
  };
}

export function verifyBrokerAuthReady(ready, proof, auth) {
  const params = proof?.params;
  if (
    proof?.method !== "broker/auth" ||
    !isAuth(auth) ||
    ready?.version !== 1 ||
    ready.operation !== params?.operation ||
    ready.brokerId !== auth.brokerId ||
    ready.generation !== auth.generation ||
    ready.clientNonce !== params.clientNonce ||
    ready.serverNonce !== params.serverNonce ||
    ready.ready !== true ||
    !equalMac(ready.mac, hmac(auth, "server-ready", params.operation, params.clientNonce, params.serverNonce))
  ) {
    throw authenticationFailed();
  }
  return true;
}

export function createBrokerOperationAck(proof, auth, outcome) {
  const params = proof?.params;
  if (
    proof?.method !== "broker/auth" ||
    !isAuth(auth) ||
    !TOKEN.test(params?.operation) ||
    !NONCE.test(params?.clientNonce) ||
    !NONCE.test(params?.serverNonce) ||
    !TOKEN.test(outcome)
  ) {
    throw authenticationFailed();
  }
  return {
    version: 1,
    operation: params.operation,
    brokerId: auth.brokerId,
    generation: auth.generation,
    clientNonce: params.clientNonce,
    serverNonce: params.serverNonce,
    outcome,
    mac: hmac(auth, `operation-ack-${outcome}`, params.operation, params.clientNonce, params.serverNonce)
  };
}

export function verifyBrokerOperationAck(ack, proof, auth, outcome) {
  const params = proof?.params;
  if (
    proof?.method !== "broker/auth" ||
    !isAuth(auth) ||
    !TOKEN.test(outcome) ||
    ack?.version !== 1 ||
    ack.operation !== params?.operation ||
    ack.brokerId !== auth.brokerId ||
    ack.generation !== auth.generation ||
    ack.clientNonce !== params.clientNonce ||
    ack.serverNonce !== params.serverNonce ||
    ack.outcome !== outcome ||
    !equalMac(ack.mac, hmac(auth, `operation-ack-${outcome}`, params.operation, params.clientNonce, params.serverNonce))
  ) {
    throw authenticationFailed();
  }
  return true;
}

export function readBrokerJsonLine(socket, timeoutMs, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => finish(new Error("Broker authentication timed out.")), timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", finish);
      socket.off("close", onClose);
    }

    function finish(error, value) {
      cleanup();
      if (error) reject(error);
      else resolve(value);
    }

    function onClose() {
      finish(new Error("Broker authentication connection closed."));
    }

    function onData(chunk) {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > maxBytes) {
        finish(new Error("Broker authentication frame is too large."));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      if (buffer.slice(newline + 1).trim()) {
        finish(new Error("Broker authentication response is malformed."));
        return;
      }
      try {
        finish(null, JSON.parse(buffer.slice(0, newline)));
      } catch {
        finish(new Error("Broker authentication response is malformed."));
      }
    }

    socket.on("data", onData);
    socket.on("error", finish);
    socket.on("close", onClose);
  });
}

export async function authenticateBrokerSocket(socket, auth, { operation = "connect", timeoutMs = 1000 } = {}) {
  const hello = createBrokerAuthHello(auth, { operation });
  socket.write(`${JSON.stringify({ id: "broker-auth-hello", ...hello })}\n`);
  const challengeMessage = await readBrokerJsonLine(socket, timeoutMs);
  if (challengeMessage?.id !== "broker-auth-hello" || !challengeMessage.result) throw authenticationFailed();
  verifyBrokerAuthChallenge(challengeMessage.result, hello, auth);

  const proof = createBrokerAuthProof(hello, challengeMessage.result, auth);
  socket.write(`${JSON.stringify({ id: "broker-auth-proof", ...proof })}\n`);
  const readyMessage = await readBrokerJsonLine(socket, timeoutMs);
  if (readyMessage?.id !== "broker-auth-proof" || !readyMessage.result) throw authenticationFailed();
  verifyBrokerAuthReady(readyMessage.result, proof, auth);
  return { hello, challenge: challengeMessage.result, proof };
}
