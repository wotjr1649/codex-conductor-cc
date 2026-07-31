#!/usr/bin/env node

import fs from "node:fs";
import readline from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.146.0\n");
  process.exit(0);
}
if (process.argv.includes("--help")) {
  process.stdout.write("P4 fixture app-server help\n");
  process.exit(0);
}

const capturePath = process.env.P4_CAPTURE_PATH;
if (!capturePath) {
  throw new Error("P4_CAPTURE_PATH is required");
}

function capture(message) {
  fs.appendFileSync(
    capturePath,
    `${JSON.stringify({ direction: "client-to-server", message })}\n`,
    "utf8"
  );
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function completedTurn(id) {
  return { id, status: "completed", items: [], error: null };
}

let nextThread = 1;
let nextTurn = 1;
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  capture(message);

  if (message.id === "p4-known" || message.id === 7) {
    return;
  }

  switch (message.method) {
    case "initialize":
      send({ id: message.id, result: { userAgent: "p4-fixture" } });
      break;
    case "initialized":
      if (process.env.P4_SERVER_REQUEST_PROBE === "1") {
        send({
          id: "p4-known",
          method: "item/commandExecution/requestApproval",
          params: { command: "fixture-only" }
        });
        send({ id: 7, method: "future/unknown", params: {} });
      }
      break;
    case "account/read":
      send({
        id: message.id,
        result: {
          account: { type: "chatgpt", email: "fixture@example.invalid" },
          requiresOpenaiAuth: true
        }
      });
      break;
    case "config/read":
      send({
        id: message.id,
        result: { config: { model_provider: "openai", model_providers: {} } }
      });
      break;
    case "thread/start": {
      const threadId = `thr_p4_${nextThread++}`;
      send({ id: message.id, result: { thread: { id: threadId } } });
      send({ method: "thread/started", params: { thread: { id: threadId } } });
      break;
    }
    case "thread/name/set":
      send({ id: message.id, result: {} });
      break;
    case "thread/resume":
      send({
        id: message.id,
        result: { thread: { id: message.params.threadId } }
      });
      break;
    case "turn/start": {
      const turnId = `turn_p4_${nextTurn++}`;
      send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
      send({
        method: "item/completed",
        params: {
          threadId: message.params.threadId,
          turnId,
          item: {
            type: "agentMessage",
            id: `msg_${turnId}`,
            text: "P4 fixture result",
            phase: "final_answer"
          }
        }
      });
      send({
        method: "turn/completed",
        params: {
          threadId: message.params.threadId,
          turn: completedTurn(turnId)
        }
      });
      break;
    }
    case "review/start": {
      const turnId = `turn_p4_${nextTurn++}`;
      send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
      send({
        method: "item/completed",
        params: {
          threadId: message.params.threadId,
          turnId,
          item: {
            type: "exitedReviewMode",
            id: `review_${turnId}`,
            review: "No material issues found."
          }
        }
      });
      send({
        method: "turn/completed",
        params: {
          threadId: message.params.threadId,
          turn: completedTurn(turnId)
        }
      });
      break;
    }
    case "externalAgentConfig/import":
      send({ id: message.id, result: {} });
      send({ method: "externalAgentConfig/import/completed", params: {} });
      break;
    case "turn/interrupt":
      send({ id: message.id, result: {} });
      break;
    default:
      send({
        id: message.id,
        error: { code: -32601, message: `Unsupported method: ${message.method}` }
      });
  }
});

input.on("close", () => process.exit(0));
