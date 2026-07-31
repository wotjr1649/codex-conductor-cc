const MIN_INT64 = -(2n ** 63n);
const MAX_INT64 = (2n ** 63n) - 1n;

export class P4FixtureError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export class LosslessNumber {
  constructor(lexeme) {
    this.lexeme = lexeme;
    Object.freeze(this);
  }
}

class JsonReader {
  constructor(text) {
    this.text = text;
    this.index = 0;
  }

  fail(message) {
    throw new P4FixtureError("P4E_JSON_SYNTAX", `${message} at byte ${this.index}`);
  }

  skipWhitespace() {
    while (
      this.index < this.text.length &&
      (this.text[this.index] === " " ||
        this.text[this.index] === "\t" ||
        this.text[this.index] === "\r" ||
        this.text[this.index] === "\n")
    ) {
      this.index += 1;
    }
  }

  parse() {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) {
      this.fail("trailing data");
    }
    return value;
  }

  parseValue() {
    const token = this.text[this.index];
    if (token === "{") {
      return this.parseObject();
    }
    if (token === "[") {
      return this.parseArray();
    }
    if (token === "\"") {
      return this.parseString();
    }
    if (token === "t") {
      return this.parseLiteral("true", true);
    }
    if (token === "f") {
      return this.parseLiteral("false", false);
    }
    if (token === "n") {
      return this.parseLiteral("null", null);
    }
    if (token === "-" || (token >= "0" && token <= "9")) {
      return this.parseNumber();
    }
    this.fail("unexpected token");
  }

  parseObject() {
    const result = Object.create(null);
    const keys = new Set();
    this.index += 1;
    this.skipWhitespace();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return result;
    }
    while (this.index < this.text.length) {
      if (this.text[this.index] !== "\"") {
        this.fail("object key must be a string");
      }
      const key = this.parseString();
      if (keys.has(key)) {
        throw new P4FixtureError("P4E_DUPLICATE_KEY", `duplicate object key ${JSON.stringify(key)}`);
      }
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ":") {
        this.fail("missing colon");
      }
      this.index += 1;
      this.skipWhitespace();
      result[key] = this.parseValue();
      this.skipWhitespace();
      if (this.text[this.index] === "}") {
        this.index += 1;
        return result;
      }
      if (this.text[this.index] !== ",") {
        this.fail("missing comma");
      }
      this.index += 1;
      this.skipWhitespace();
    }
    this.fail("unterminated object");
  }

  parseArray() {
    const result = [];
    this.index += 1;
    this.skipWhitespace();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return result;
    }
    while (this.index < this.text.length) {
      result.push(this.parseValue());
      this.skipWhitespace();
      if (this.text[this.index] === "]") {
        this.index += 1;
        return result;
      }
      if (this.text[this.index] !== ",") {
        this.fail("missing comma");
      }
      this.index += 1;
      this.skipWhitespace();
    }
    this.fail("unterminated array");
  }

  parseString() {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      if (character === "\"") {
        this.index += 1;
        try {
          return JSON.parse(this.text.slice(start, this.index));
        } catch {
          this.fail("invalid string escape");
        }
      }
      if (character === "\\") {
        this.index += 2;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) {
        this.fail("unescaped control character");
      }
      this.index += 1;
    }
    this.fail("unterminated string");
  }

  parseNumber() {
    const remainder = this.text.slice(this.index);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(remainder);
    if (!match) {
      this.fail("invalid number");
    }
    this.index += match[0].length;
    return new LosslessNumber(match[0]);
  }

  parseLiteral(literal, value) {
    if (!this.text.startsWith(literal, this.index)) {
      this.fail(`invalid ${literal} literal`);
    }
    this.index += literal.length;
    return value;
  }
}

export function parseLosslessJson(text) {
  return new JsonReader(text).parse();
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function requestIdIdentity(id) {
  if (typeof id === "string") {
    return {
      type: "string",
      lexeme: id,
      correlationKey: `s:${Buffer.byteLength(id, "utf8")}:${id}`
    };
  }
  if (!(id instanceof LosslessNumber) || !/^-?(?:0|[1-9]\d*)$/.test(id.lexeme)) {
    throw new P4FixtureError("P4E_REQUEST_ID_TYPE", "id must be a string or signed 64-bit integer");
  }
  const integer = BigInt(id.lexeme);
  if (integer < MIN_INT64 || integer > MAX_INT64) {
    throw new P4FixtureError("P4E_REQUEST_ID_RANGE", "numeric id is outside signed 64-bit range");
  }
  return {
    type: "integer",
    lexeme: id.lexeme,
    correlationKey: `n:${id.lexeme}`
  };
}

export function admitRpcMessage(message) {
  if (
    !message ||
    typeof message !== "object" ||
    Array.isArray(message) ||
    message instanceof LosslessNumber
  ) {
    throw new P4FixtureError("P4E_RPC_ROOT", "RPC message must be an object");
  }
  const hasId = own(message, "id");
  const hasMethod = own(message, "method");
  const hasResult = own(message, "result");
  const hasError = own(message, "error");
  if (hasResult && hasError) {
    throw new P4FixtureError("P4E_RPC_EXCLUSIVITY", "response cannot contain both result and error");
  }
  const id = hasId ? requestIdIdentity(message.id) : null;
  if (hasMethod) {
    if (typeof message.method !== "string" || message.method.length === 0) {
      throw new P4FixtureError("P4E_RPC_METHOD", "method must be a non-empty string");
    }
    if (hasResult || hasError) {
      throw new P4FixtureError("P4E_RPC_ENVELOPE", "request/notification cannot contain result or error");
    }
    return {
      kind: hasId ? "request" : "notification",
      id,
      method: message.method,
      value: message
    };
  }
  if (!hasId || hasResult === hasError) {
    throw new P4FixtureError(
      "P4E_RPC_ENVELOPE",
      "response requires id and exactly one of result or error"
    );
  }
  return {
    kind: "response",
    id,
    outcome: hasError ? "error" : "result",
    value: message
  };
}

export class StrictJsonlFixture {
  constructor({ maxLineBytes = 65_536 } = {}) {
    this.maxLineBytes = maxLineBytes;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.observedLineBytes = [];
  }

  push(chunk) {
    if (this.closed) {
      throw new P4FixtureError("P4E_FRAMER_CLOSED", "cannot push after finish");
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, bytes]);
    const messages = [];
    let newline = this.buffer.indexOf(0x0a);
    while (newline !== -1) {
      let line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.at(-1) === 0x0d) {
        line = line.subarray(0, -1);
      }
      const message = this.parseLine(line);
      if (message) {
        messages.push(message);
      }
      newline = this.buffer.indexOf(0x0a);
    }
    if (this.buffer.length > this.maxLineBytes) {
      throw new P4FixtureError("P4E_LINE_LIMIT", "partial line exceeds candidate byte limit");
    }
    return messages;
  }

  parseLine(line) {
    this.observedLineBytes.push(line.length);
    if (line.length > this.maxLineBytes) {
      throw new P4FixtureError("P4E_LINE_LIMIT", "line exceeds candidate byte limit");
    }
    if (
      line.length >= 3 &&
      line[0] === 0xef &&
      line[1] === 0xbb &&
      line[2] === 0xbf
    ) {
      throw new P4FixtureError("P4E_BOM", "UTF-8 BOM is forbidden");
    }
    if (line.includes(0x00)) {
      throw new P4FixtureError("P4E_NUL", "NUL is forbidden");
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    } catch {
      throw new P4FixtureError("P4E_INVALID_UTF8", "line is not valid UTF-8");
    }
    if (!text.trim()) {
      return null;
    }
    return admitRpcMessage(parseLosslessJson(text));
  }

  finish() {
    if (this.closed) {
      return [];
    }
    this.closed = true;
    if (this.buffer.length !== 0) {
      throw new P4FixtureError("P4E_INCOMPLETE_EOF", "EOF arrived before the JSONL delimiter");
    }
    return [];
  }
}

export class CorrelationFixture {
  constructor() {
    this.pending = new Map();
    this.settled = new Set();
  }

  add(id) {
    const identity = requestIdIdentity(id);
    if (this.pending.has(identity.correlationKey) || this.settled.has(identity.correlationKey)) {
      throw new P4FixtureError("P4E_DUPLICATE_REQUEST_ID", "request id is already known");
    }
    this.pending.set(identity.correlationKey, identity);
    return identity.correlationKey;
  }

  resolve(message) {
    const admitted = admitRpcMessage(message);
    if (admitted.kind !== "response") {
      throw new P4FixtureError("P4E_NOT_RESPONSE", "correlation accepts responses only");
    }
    const key = admitted.id.correlationKey;
    if (this.settled.has(key)) {
      throw new P4FixtureError("P4E_DUPLICATE_RESPONSE", "response id is already settled");
    }
    if (!this.pending.has(key)) {
      throw new P4FixtureError("P4E_UNKNOWN_RESPONSE", "response id is not pending");
    }
    this.pending.delete(key);
    this.settled.add(key);
    return admitted;
  }
}
