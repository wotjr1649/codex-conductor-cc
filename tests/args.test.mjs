import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";
import { listCreatedTempDirs, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

after(() => {
  for (const directory of listCreatedTempDirs()) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// Mirrors the option sets the free-text commands declare in codex-companion.mjs.
const TASK_CONFIG = {
  valueOptions: ["model", "effort", "cwd", "prompt-file"],
  booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
  optionsBeforePositionals: true
};

// Mirrors `status`, which documents `[job-id] [--wait] ...` — positional first.
const STATUS_CONFIG = {
  valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
  booleanOptions: ["json", "all", "wait"]
};

// Reproduces what parseCommandInput does for a slash command: one raw blob,
// tokenized, then parsed.
function parseRawCommand(raw, config) {
  return parseArgs(splitRawArgumentString(raw), config);
}

test("a flag written inside prompt prose does not become an option", () => {
  const { options, positionals } = parseRawCommand(
    "diagnose why the --write flag is ignored, do not edit files",
    TASK_CONFIG
  );

  assert.equal(options.write, undefined);
  assert.ok(positionals.includes("--write"), "the flag token must survive as prompt text");
});

test("a flag written before the prompt is still parsed as an option", () => {
  const { options, positionals } = parseRawCommand("--write fix the failing build", TASK_CONFIG);

  assert.equal(options.write, true);
  assert.deepEqual(positionals, ["fix", "the", "failing", "build"]);
});

test("a flag appended after the prompt stays prompt text", () => {
  // The other half of the rule, and the one a caller can get wrong without noticing: writing
  // `task "..." --write` produces a read-only run whose prompt happens to end in "--write". The
  // rescue agent's contract has to put flags first for exactly this reason.
  const { options, positionals } = parseRawCommand("fix the failing build --write", TASK_CONFIG);

  assert.equal(options.write, undefined);
  assert.ok(positionals.includes("--write"), "the flag token must survive as prompt text");
});

test("a value option inside prompt prose does not swallow the following word", () => {
  const { options, positionals } = parseRawCommand(
    "explain the --model selection logic",
    TASK_CONFIG
  );

  assert.equal(options.model, undefined);
  assert.deepEqual(positionals, ["explain", "the", "--model", "selection", "logic"]);
});

test("commands that take a structured positional still parse options after it", () => {
  const { options, positionals } = parseRawCommand("task-abc --wait", STATUS_CONFIG);

  assert.deepEqual(positionals, ["task-abc"]);
  assert.equal(options.wait, true);
});

test("an explicit -- still ends option parsing before the first positional", () => {
  const { options, positionals } = parseRawCommand("--write -- --model stays-text", TASK_CONFIG);

  assert.equal(options.write, true);
  assert.equal(options.model, undefined);
  assert.deepEqual(positionals, ["--model", "stays-text"]);
});

test("an unquoted Windows path keeps its backslashes", () => {
  assert.deepEqual(splitRawArgumentString("C:\\Users\\js\\file.txt"), ["C:\\Users\\js\\file.txt"]);
});

test("a double-quoted Windows path keeps its backslashes", () => {
  assert.deepEqual(splitRawArgumentString("\"C:\\Program Files\\Git\\bin\""), [
    "C:\\Program Files\\Git\\bin"
  ]);
});

test("a single-quoted Windows path keeps its backslashes", () => {
  assert.deepEqual(splitRawArgumentString("'C:\\Users\\js'"), ["C:\\Users\\js"]);
});

test("backslashes inside prose survive tokenization", () => {
  assert.deepEqual(splitRawArgumentString("fix the \\d+ regex in src\\parser.js"), [
    "fix",
    "the",
    "\\d+",
    "regex",
    "in",
    "src\\parser.js"
  ]);
});

test("a backslash still escapes a double quote inside a double-quoted token", () => {
  assert.deepEqual(splitRawArgumentString("\"say \\\"hi\\\"\""), ["say \"hi\""]);
});

test("a backslash still escapes a backslash inside a double-quoted token", () => {
  assert.deepEqual(splitRawArgumentString("\"trailing\\\\\""), ["trailing\\"]);
});

test("an inline option value keeps every character after the first equals sign", () => {
  const { options } = parseArgs(["--cwd=/srv/build=2/repo"], { valueOptions: ["cwd"] });

  assert.equal(options.cwd, "/srv/build=2/repo");
});

// End-to-end through the CLI, because a slash command passes every argument as one
// blob. Reaching the Codex-availability check proves the prose flag was not consumed:
// reasoning effort is validated earlier, so parsing it would fail first. Nothing here
// starts a broker.
test("the task command does not consume a flag written inside its prompt prose", () => {
  const workspace = makeTempDir("codex-args-workspace-");
  const emptyBin = makeTempDir("codex-args-nobin-");

  const result = run(process.execPath, [SCRIPT, "task", "--background explain the --effort flag"], {
    cwd: workspace,
    env: { ...process.env, PATH: emptyBin }
  });

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.doesNotMatch(output, /Unsupported reasoning effort/);
  assert.match(output, /Codex CLI is not installed/);
});
