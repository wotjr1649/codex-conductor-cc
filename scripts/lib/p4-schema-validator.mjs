const VALIDATION_KEYWORDS = new Set([
  "$ref",
  "additionalProperties",
  "const",
  "enum",
  "format",
  "items",
  "maxItems",
  "minItems",
  "minLength",
  "minimum",
  "pattern",
  "properties",
  "required",
  "type"
]);

const ANNOTATION_KEYWORDS = new Set([
  "$defs",
  "$id",
  "$schema",
  "description",
  "title"
]);

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resolveLocalReference(rootSchema, reference) {
  if (!reference.startsWith("#/")) {
    throw new Error(`P4E_SCHEMA_REF: only local JSON Pointer references are supported (${reference})`);
  }
  let value = rootSchema;
  for (const rawToken of reference.slice(2).split("/")) {
    const token = rawToken.replaceAll("~1", "/").replaceAll("~0", "~");
    value = value?.[token];
  }
  if (!value || typeof value !== "object") {
    throw new Error(`P4E_SCHEMA_REF: unresolved reference ${reference}`);
  }
  return value;
}

function matchesType(value, expected) {
  switch (expected) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "string":
      return typeof value === "string";
    default:
      throw new Error(`P4E_SCHEMA_TYPE: unsupported type ${expected}`);
  }
}

function validFullDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12 || day < 1) return false;
  const probe = new Date(0);
  probe.setUTCHours(0, 0, 0, 0);
  probe.setUTCFullYear(year, month, 0);
  return day <= probe.getUTCDate();
}

function validRfc3339DateTime(value) {
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(
      value
    );
  if (!match || !validFullDate(match[1])) return false;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  if (hour > 23 || minute > 59 || second > 60) return false;
  if (match[5] !== "Z") {
    const [offsetHour, offsetMinute] = match[5].slice(1).split(":").map(Number);
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return true;
}

function validateFormat(value, format, location, errors) {
  if (typeof value !== "string") return;
  if (format === "date") {
    if (!validFullDate(value)) errors.push(`${location}: invalid date`);
    return;
  }
  if (format === "date-time") {
    if (!validRfc3339DateTime(value)) {
      errors.push(`${location}: invalid date-time`);
    }
    return;
  }
  throw new Error(`P4E_SCHEMA_FORMAT: unsupported format ${format}`);
}

function validateNode(value, schema, rootSchema, location, errors) {
  for (const keyword of Object.keys(schema)) {
    if (!VALIDATION_KEYWORDS.has(keyword) && !ANNOTATION_KEYWORDS.has(keyword)) {
      throw new Error(`P4E_SCHEMA_KEYWORD: unsupported keyword ${keyword} at ${location}`);
    }
  }

  if (schema.$ref) {
    validateNode(value, resolveLocalReference(rootSchema, schema.$ref), rootSchema, location, errors);
  }

  if ("const" in schema && !sameValue(value, schema.const)) {
    errors.push(`${location}: const mismatch`);
  }
  if (schema.enum && !schema.enum.some((candidate) => sameValue(value, candidate))) {
    errors.push(`${location}: value is not in enum`);
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${location}: expected type ${types.join("|")}`);
      return;
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${location}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.pattern !== undefined && !(new RegExp(schema.pattern, "u")).test(value)) {
      errors.push(`${location}: pattern mismatch`);
    }
    if (schema.format !== undefined) {
      validateFormat(value, schema.format, location, errors);
    }
  }

  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${location}: below minimum ${schema.minimum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${location}: fewer than minItems ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${location}: more than maxItems ${schema.maxItems}`);
    }
    if (schema.items) {
      value.forEach((item, index) =>
        validateNode(item, schema.items, rootSchema, `${location}[${index}]`, errors)
      );
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        errors.push(`${location}: missing required property ${required}`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) {
        validateNode(child, properties[key], rootSchema, `${location}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${location}: unknown property ${key}`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        validateNode(child, schema.additionalProperties, rootSchema, `${location}.${key}`, errors);
      }
    }
  }
}

export function validateJsonSchema(value, schema, label = "$") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("P4E_SCHEMA_ROOT: schema object required");
  }
  const errors = [];
  validateNode(value, schema, schema, label, errors);
  return errors;
}

export function assertJsonSchema(value, schema, label = "$") {
  const errors = validateJsonSchema(value, schema, label);
  if (errors.length > 0) {
    throw new Error(`P4E_SCHEMA_VALIDATION: ${errors.join("; ")}`);
  }
}
