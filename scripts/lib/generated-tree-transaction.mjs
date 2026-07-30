import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const GENERATED_TYPES_RELATIVE =
  "plugins/codex/.generated/app-server-types";

const OWNER = "codex-plugin-cc-schema-publish-v1";
const MARKER_NAME = ".app-server-types.publish.json";
const LOCK_NAME = ".app-server-types.publish.lock";
const LOCK_CLAIM_NAME = ".app-server-types.publish.recovery-claim.json";
const LOCK_PENDING_OWNER_PREFIX = ".app-server-types.publish.pending-owner-";
const LOCK_PENDING_CLAIM_PREFIX = ".app-server-types.publish.pending-claim-";
const LOCK_STALE_CLAIM_PREFIX =
  ".app-server-types.publish.stale-recovery-claim-";
const STATES = ["prepared", "old_moved", "new_published", "committed"];
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MARKER_KEYS = [
  "backup",
  "destination",
  "hadOldDestination",
  "lockToken",
  "newDigest",
  "oldDigest",
  "owner",
  "ownerPid",
  "pathToken",
  "schemaVersion",
  "stage",
  "state",
  "transactionId"
];

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function toMarkerPath(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || !isInside(root, candidate)) {
    throw new Error("Transaction path must be a non-root repository path.");
  }
  return relative.split(path.sep).join("/");
}

function fromMarkerPath(root, value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    path.posix.isAbsolute(value) ||
    value.split("/").includes("..")
  ) {
    throw new Error("Transaction marker contains an invalid relative path.");
  }
  const resolved = path.resolve(root, ...value.split("/"));
  if (!isInside(root, resolved)) {
    throw new Error("Transaction marker path escapes the repository.");
  }
  return resolved;
}

async function lstatOptional(candidate) {
  try {
    return await fsp.lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writePublishedLockRecord(
  lockPath,
  finalName,
  value,
  pendingPrefix,
  onPendingCreated = null,
  onPendingSynced = null
) {
  const pendingName = `${pendingPrefix}${process.pid}-${value.token}.json`;
  const pendingPath = path.join(lockPath, pendingName);
  const finalPath = path.join(lockPath, finalName);
  let handle = null;
  let pendingCreated = false;
  try {
    handle = await fsp.open(pendingPath, "wx", 0o600);
    pendingCreated = true;
    if (onPendingCreated) {
      await onPendingCreated();
    }
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    if (onPendingSynced) {
      await onPendingSynced();
    }
    await fsp.link(pendingPath, finalPath);
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
    if (pendingCreated) {
      await fsp.unlink(pendingPath).catch((error) => {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      });
    }
  }
}

async function readSmallJsonFile(filePath, label) {
  const stats = await fsp.lstat(filePath);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > 64 * 1024) {
    throw new Error(`${label} is not a small ordinary file.`);
  }
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw error;
    }
    throw new Error(`${label} is not valid JSON.`);
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function validateLockRecord(record, kind) {
  const expectedKeys =
    kind === "owner"
      ? ["owner", "pathToken", "pid", "runId", "token"]
      : ["owner", "pid", "token"];
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(record)
      .sort()
      .some((key, index) => key !== expectedKeys[index]) ||
    Object.keys(record).length !== expectedKeys.length ||
    record.owner !== OWNER ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.token !== "string" ||
    !RUN_ID_PATTERN.test(record.token) ||
    (kind === "owner" && !RUN_ID_PATTERN.test(record.pathToken)) ||
    (kind === "owner" && !RUN_ID_PATTERN.test(record.runId))
  ) {
    throw new Error(`Transaction lock ${kind} record is invalid.`);
  }
  return record;
}

function lockRecordsEqual(left, right, kind) {
  const keys =
    kind === "owner"
      ? ["owner", "pathToken", "pid", "runId", "token"]
      : ["owner", "pid", "token"];
  return keys.every((key) => left?.[key] === right?.[key]);
}

async function assertLockRecordFile(lockPath, label) {
  const stats = await fsp.lstat(lockPath);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > 64 * 1024) {
    throw new Error(`${label} is not a small ordinary file.`);
  }
}

async function assertLockRecordEquals(filePath, expected, kind, label) {
  await assertLockRecordFile(filePath, label);
  const current = validateLockRecord(
    await readSmallJsonFile(filePath, label),
    kind
  );
  if (!lockRecordsEqual(current, expected, kind)) {
    throw new Error(`${label} changed unexpectedly.`);
  }
}

async function unlinkVerifiedLockRecord(filePath, expected, kind, label) {
  await assertLockRecordEquals(filePath, expected, kind, label);
  await fsp.unlink(filePath);
}

function pendingLockRecordPid(name) {
  for (const prefix of [
    LOCK_PENDING_OWNER_PREFIX,
    LOCK_PENDING_CLAIM_PREFIX
  ]) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) {
      continue;
    }
    const remainder = name.slice(prefix.length, -".json".length);
    const separator = remainder.indexOf("-");
    const pid = Number(remainder.slice(0, separator));
    if (
      separator > 0 &&
      Number.isSafeInteger(pid) &&
      pid > 0 &&
      RUN_ID_PATTERN.test(remainder.slice(separator + 1))
    ) {
      return pid;
    }
  }
  return null;
}

async function cleanRecoverableLockArtifacts(parent) {
  for (const name of await fsp.readdir(parent)) {
    const candidate = path.join(parent, name);
    const pendingPid = pendingLockRecordPid(name);
    if (pendingPid !== null) {
      const stats = await fsp.lstat(candidate);
      if (stats.isSymbolicLink() || !stats.isFile() || stats.size > 64 * 1024) {
        throw new Error("Pending transaction lock record is not a small ordinary file.");
      }
      if (isProcessAlive(pendingPid)) {
        throw new Error(
          `An active schema publish process is initializing the lock (pid ${pendingPid}).`
        );
      }
      await fsp.unlink(candidate);
      continue;
    }

    if (name.startsWith(LOCK_STALE_CLAIM_PREFIX) && name.endsWith(".json")) {
      const staleClaim = validateLockRecord(
        await readSmallJsonFile(candidate, "Stale recovery claim"),
        "claim"
      );
      if (isProcessAlive(staleClaim.pid)) {
        throw new Error(
          `An active schema publish recovery owns a stale claim transition (pid ${staleClaim.pid}).`
        );
      }
      await fsp.unlink(candidate);
    }
  }
}

async function clearOrRejectExistingClaim(
  parent,
  ownerPath,
  owner,
  onBoundary = null
) {
  const claimPath = path.join(parent, LOCK_CLAIM_NAME);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await lstatOptional(claimPath))) {
      return;
    }
    if (onBoundary) {
      await onBoundary("after_fresh_owner_observed_recovery_claim", {});
    }
    let claim;
    try {
      claim = validateLockRecord(
        await readSmallJsonFile(claimPath, "Transaction recovery claim"),
        "claim"
      );
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (isProcessAlive(claim.pid)) {
      await unlinkVerifiedLockRecord(
        ownerPath,
        owner,
        "owner",
        "Transaction lock owner"
      );
      throw new Error(
        `An active schema publish recovery is finalizing the previous lock (pid ${claim.pid}).`
      );
    }

    const stalePath = path.join(
      parent,
      `${LOCK_STALE_CLAIM_PREFIX}${randomUUID()}.json`
    );
    try {
      await fsp.rename(claimPath, stalePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    const staleClaim = validateLockRecord(
      await readSmallJsonFile(stalePath, "Stale recovery claim"),
      "claim"
    );
    if (!lockRecordsEqual(staleClaim, claim, "claim")) {
      throw new Error("Recovery claim changed during orphan cleanup.");
    }
    await fsp.unlink(stalePath);
    return;
  }
  throw new Error("Could not establish an unclaimed fresh transaction lock.");
}

async function acquireTransactionLock(
  parent,
  requestedRunId,
  onBoundary = null
) {
  const ownerPath = path.join(parent, LOCK_NAME);
  const token = randomUUID();
  const owner = {
    owner: OWNER,
    pathToken: randomUUID(),
    pid: process.pid,
    runId: requestedRunId,
    token
  };

  await cleanRecoverableLockArtifacts(parent);
  try {
    await writePublishedLockRecord(
      parent,
      LOCK_NAME,
      owner,
      LOCK_PENDING_OWNER_PREFIX,
      onBoundary
        ? () => onBoundary("after_lock_owner_temp_created", {})
        : null,
      onBoundary
        ? () =>
            onBoundary(
              "after_lock_owner_temp_sync_before_publish",
              {}
            )
        : null
    );
    if (onBoundary) {
      await onBoundary("after_lock_owner_published", {});
    }
    await clearOrRejectExistingClaim(
      parent,
      ownerPath,
      owner,
      onBoundary
    );
    return {
      parent,
      ownerPath,
      claimPath: null,
      claim: null,
      owner,
      recovery: false
    };
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }

  await assertLockRecordFile(ownerPath, "Transaction lock owner");
  const existingOwner = validateLockRecord(
    await readSmallJsonFile(ownerPath, "Transaction lock owner"),
    "owner"
  );
  if (isProcessAlive(existingOwner.pid)) {
    throw new Error(
      `An active schema publish transaction already holds the lock (pid ${existingOwner.pid}).`
    );
  }

  const claimPath = path.join(parent, LOCK_CLAIM_NAME);
  const claim = {
    owner: OWNER,
    pid: process.pid,
    token: randomUUID()
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await writePublishedLockRecord(
        parent,
        LOCK_CLAIM_NAME,
        claim,
        LOCK_PENDING_CLAIM_PREFIX
      );
      try {
        await assertLockRecordEquals(
          ownerPath,
          existingOwner,
          "owner",
          "Transaction lock owner"
        );
      } catch (ownerError) {
        try {
          await unlinkVerifiedLockRecord(
            claimPath,
            claim,
            "claim",
            "Transaction recovery claim"
          );
        } catch (cleanupError) {
          throw new AggregateError(
            [ownerError, cleanupError],
            "Transaction owner changed during recovery claim acquisition and claim cleanup failed."
          );
        }
        throw new Error(
          "Transaction owner changed during recovery claim acquisition.",
          { cause: ownerError }
        );
      }
      return {
        parent,
        ownerPath,
        claimPath,
        claim,
        owner: existingOwner,
        recovery: true
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }

    const existingClaim = validateLockRecord(
      await readSmallJsonFile(claimPath, "Transaction recovery claim"),
      "claim"
    );
    if (isProcessAlive(existingClaim.pid)) {
      throw new Error(
        `An active schema publish recovery already holds the claim (pid ${existingClaim.pid}).`
      );
    }

    const stalePath = path.join(
      parent,
      `${LOCK_STALE_CLAIM_PREFIX}${randomUUID()}.json`
    );
    try {
      await fsp.rename(claimPath, stalePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    const staleClaim = validateLockRecord(
      await readSmallJsonFile(stalePath, "Stale recovery claim"),
      "claim"
    );
    if (
      staleClaim.token !== existingClaim.token ||
      staleClaim.pid !== existingClaim.pid
    ) {
      throw new Error("Recovery claim changed during takeover.");
    }
    await fsp.unlink(stalePath);
  }
  throw new Error("Could not acquire the schema publish recovery claim.");
}

async function releaseTransactionLock(lock, onBoundary = null) {
  await assertLockRecordFile(lock.ownerPath, "Transaction lock owner");
  const currentOwner = validateLockRecord(
    await readSmallJsonFile(lock.ownerPath, "Transaction lock owner"),
    "owner"
  );
  if (
    currentOwner.token !== lock.owner.token ||
    currentOwner.pid !== lock.owner.pid ||
    currentOwner.runId !== lock.owner.runId ||
    currentOwner.pathToken !== lock.owner.pathToken
  ) {
    throw new Error("Transaction lock ownership changed before release.");
  }

  if (lock.claimPath) {
    const currentClaim = validateLockRecord(
      await readSmallJsonFile(lock.claimPath, "Transaction recovery claim"),
      "claim"
    );
    if (
      currentClaim.token !== lock.claim.token ||
      currentClaim.pid !== lock.claim.pid
    ) {
      throw new Error("Transaction recovery claim changed before release.");
    }
  }

  if (onBoundary) {
    await onBoundary("before_lock_release", {});
  }
  await fsp.unlink(lock.ownerPath);
  if (onBoundary) {
    await onBoundary("after_lock_owner_removed", {});
  }
  if (lock.claimPath) {
    await fsp.unlink(lock.claimPath);
    if (onBoundary) {
      await onBoundary("after_lock_claim_removed", {});
    }
  }
}

async function assertOrdinaryDirectory(candidate, label) {
  const stats = await lstatOptional(candidate);
  if (!stats) {
    throw new Error(`${label} does not exist.`);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be an ordinary directory.`);
  }
  const canonical = await fsp.realpath(candidate);
  if (!samePath(canonical, candidate)) {
    throw new Error(`${label} resolves through a link or redirect.`);
  }
}

async function assertSafeExistingComponents(root, target) {
  if (!isInside(root, target)) {
    throw new Error("Generated schema path escapes the repository.");
  }

  await assertOrdinaryDirectory(root, "Repository root");
  const relative = path.relative(root, target);
  let cursor = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const stats = await lstatOptional(cursor);
    if (!stats) {
      continue;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(
        `Generated schema path contains a link, reparse redirect, or non-directory: ${component}`
      );
    }
    const canonical = await fsp.realpath(cursor);
    if (!samePath(canonical, cursor)) {
      throw new Error(
        `Generated schema path resolves through a link or reparse redirect: ${component}`
      );
    }
  }
}

async function walkTree(root, { requireTypeScript = false } = {}) {
  await assertOrdinaryDirectory(root, "Generated tree");
  const entries = [];
  let fileCount = 0;
  let typeScriptCount = 0;

  async function visit(directory, relativeDirectory) {
    const names = await fsp.readdir(directory);
    names.sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
    );

    for (const name of names) {
      const absolute = path.join(directory, name);
      const relative = relativeDirectory
        ? `${relativeDirectory}/${name}`
        : name;
      const stats = await fsp.lstat(absolute);

      if (stats.isSymbolicLink()) {
        throw new Error(`Generated tree contains a link or reparse redirect: ${relative}`);
      }
      if (stats.isDirectory()) {
        const canonical = await fsp.realpath(absolute);
        if (!samePath(canonical, absolute)) {
          throw new Error(
            `Generated tree directory resolves through a redirect: ${relative}`
          );
        }
        entries.push({ kind: "directory", relative });
        await visit(absolute, relative);
      } else if (stats.isFile()) {
        entries.push({
          kind: "file",
          relative,
          size: stats.size,
          content: await fsp.readFile(absolute)
        });
        fileCount += 1;
        if (relative.endsWith(".ts")) {
          typeScriptCount += 1;
        }
      } else {
        throw new Error(`Generated tree contains a special file: ${relative}`);
      }
    }
  }

  await visit(root, "");
  if (requireTypeScript && (fileCount === 0 || typeScriptCount === 0)) {
    throw new Error("Schema generator produced no TypeScript files.");
  }
  return entries;
}

export async function digestGeneratedTree(
  root,
  { requireTypeScript = false } = {}
) {
  const entries = await walkTree(root, { requireTypeScript });
  const hash = createHash("sha256");
  hash.update("codex-generated-tree-v1\0");

  for (const entry of entries) {
    hash.update(entry.kind === "directory" ? "D\0" : "F\0");
    hash.update(entry.relative);
    hash.update("\0");
    if (entry.kind === "file") {
      hash.update(String(entry.size));
      hash.update("\0");
      hash.update(entry.content);
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

async function treeDigestOptional(candidate) {
  const stats = await lstatOptional(candidate);
  if (!stats) {
    return null;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Transaction tree path is not an ordinary directory.");
  }
  return digestGeneratedTree(candidate);
}

function assertOwnedSibling(candidate, parent, expectedPrefix) {
  if (
    !samePath(path.dirname(candidate), parent) ||
    !path.basename(candidate).startsWith(expectedPrefix)
  ) {
    throw new Error("Transaction path is not a verified run-owned sibling.");
  }
}

async function removeOwnedTree(
  candidate,
  parent,
  expectedPrefix,
  expectedDigest = null
) {
  assertOwnedSibling(candidate, parent, expectedPrefix);
  const actualDigest = await treeDigestOptional(candidate);
  if (actualDigest === null) {
    return;
  }
  if (expectedDigest !== null && actualDigest !== expectedDigest) {
    throw new Error("Refusing to remove a transaction tree with a digest mismatch.");
  }
  await fsp.rm(candidate, { recursive: true, force: false });
}

function markerWithState(marker, state) {
  if (!STATES.includes(state)) {
    throw new Error(`Unknown transaction state: ${state}`);
  }
  return { ...marker, state };
}

function markersEqual(left, right) {
  return MARKER_KEYS.every((key) => left?.[key] === right?.[key]);
}

async function assertMarkerEquals(markerPath, expectedMarker) {
  const current = await readMarkerFile(markerPath);
  if (!markersEqual(current, expectedMarker)) {
    throw new Error("Transaction marker changed unexpectedly.");
  }
}

async function writeMarker(
  markerPath,
  marker,
  { onBoundary = null, expectedPrevious = null } = {}
) {
  const tempPath = `${markerPath}.tmp-${marker.transactionId}-${randomUUID()}`;
  const handle = await fsp.open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(marker, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  if (onBoundary) {
    await onBoundary("after_marker_temp_sync_before_rename", {
      state: marker.state
    });
  }

  const existing = await lstatOptional(markerPath);
  if (expectedPrevious === null) {
    if (existing) {
      throw new Error("Refusing to overwrite an existing transaction marker.");
    }
  } else {
    if (!existing) {
      throw new Error("Transaction marker disappeared before a state transition.");
    }
    await assertMarkerEquals(markerPath, expectedPrevious);
  }

  await fsp.rename(tempPath, markerPath);
  await assertMarkerEquals(markerPath, marker);
}

async function readMarkerFile(markerPath) {
  return readSmallJsonFile(markerPath, "Transaction marker");
}

function validateMarker(marker, root, destination, parent, lock) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    throw new Error("Transaction marker must be an object.");
  }
  const keys = Object.keys(marker).sort();
  if (
    keys.length !== MARKER_KEYS.length ||
    keys.some((key, index) => key !== MARKER_KEYS[index])
  ) {
    throw new Error("Transaction marker has an unexpected shape.");
  }
  if (
    marker.schemaVersion !== 1 ||
    marker.owner !== OWNER ||
    !RUN_ID_PATTERN.test(marker.transactionId) ||
    !RUN_ID_PATTERN.test(marker.lockToken) ||
    !RUN_ID_PATTERN.test(marker.pathToken) ||
    !Number.isSafeInteger(marker.ownerPid) ||
    marker.ownerPid <= 0 ||
    !STATES.includes(marker.state) ||
    typeof marker.hadOldDestination !== "boolean" ||
    !DIGEST_PATTERN.test(marker.newDigest) ||
    (marker.hadOldDestination
      ? !DIGEST_PATTERN.test(marker.oldDigest)
      : marker.oldDigest !== null)
  ) {
    throw new Error("Transaction marker metadata is invalid.");
  }
  if (
    marker.transactionId !== lock.owner.runId ||
    marker.lockToken !== lock.owner.token ||
    marker.pathToken !== lock.owner.pathToken ||
    marker.ownerPid !== lock.owner.pid
  ) {
    throw new Error("Transaction marker does not match the active lock owner.");
  }

  const markerDestination = fromMarkerPath(root, marker.destination);
  const stage = fromMarkerPath(root, marker.stage);
  const backup = fromMarkerPath(root, marker.backup);
  if (!samePath(markerDestination, destination)) {
    throw new Error("Transaction marker targets a different destination.");
  }
  assertOwnedSibling(
    stage,
    parent,
    `.app-server-types.stage-${marker.pathToken}-`
  );
  assertOwnedSibling(
    backup,
    parent,
    `.app-server-types.backup-${marker.pathToken}`
  );
  if (
    path.basename(backup) !==
    `.app-server-types.backup-${marker.pathToken}`
  ) {
    throw new Error("Transaction backup path is not the exact owned sibling.");
  }
  if (samePath(stage, backup) || samePath(stage, destination) || samePath(backup, destination)) {
    throw new Error("Transaction marker paths overlap.");
  }
  return { stage, backup };
}

function sameTransaction(left, right) {
  return MARKER_KEYS.every(
    (key) => key === "state" || left[key] === right[key]
  );
}

async function unlinkVerifiedMarker(markerPath, expectedMarker) {
  const current = await readMarkerFile(markerPath);
  if (!markersEqual(current, expectedMarker)) {
    throw new Error("Transaction marker ownership changed during recovery.");
  }
  await fsp.unlink(markerPath);
}

async function listMarkerTemps(parent, markerPath) {
  const prefix = `${path.basename(markerPath)}.tmp-`;
  const names = await fsp.readdir(parent);
  return names
    .filter((name) => name.startsWith(prefix))
    .sort()
    .map((name) => path.join(parent, name));
}

async function removeVerifiedMarkerTemps(tempPaths, marker) {
  for (const tempPath of tempPaths) {
    const stats = await lstatOptional(tempPath);
    if (!stats) {
      continue;
    }
    const tempMarker = await readMarkerFile(tempPath);
    if (!sameTransaction(marker, tempMarker)) {
      throw new Error("Orphan marker temp belongs to a different transaction.");
    }
    await fsp.unlink(tempPath);
  }
}

async function finishPublishedRecovery({
  marker,
  markerPath,
  destination,
  parent,
  stage,
  backup,
  tempPaths,
  lock
}) {
  const destinationDigest = await treeDigestOptional(destination);
  const stageDigest = await treeDigestOptional(stage);
  const backupDigest = await treeDigestOptional(backup);

  if (destinationDigest !== marker.newDigest || stageDigest !== null) {
    throw new Error("Published transaction state does not match the new tree.");
  }
  if (
    backupDigest !== null &&
    (!marker.hadOldDestination || backupDigest !== marker.oldDigest)
  ) {
    throw new Error("Published transaction backup has an unexpected digest.");
  }
  if (backupDigest !== null) {
    await removeOwnedTree(
      backup,
      parent,
      `.app-server-types.backup-${marker.pathToken}`,
      marker.oldDigest
    );
  }

  if (marker.state !== "committed") {
    const previous = marker;
    marker = markerWithState(marker, "committed");
    await writeMarker(markerPath, marker, {
      expectedPrevious: previous
    });
  }
  await unlinkVerifiedMarker(markerPath, marker);
  await removeVerifiedMarkerTemps(tempPaths, marker);
}

async function recoverMarker({
  root,
  destination,
  parent,
  markerPath,
  marker,
  tempPaths,
  lock
}) {
  const { stage, backup } = validateMarker(
    marker,
    root,
    destination,
    parent,
    lock
  );
  const stageDigest = await treeDigestOptional(stage);
  const destinationDigest = await treeDigestOptional(destination);
  const backupDigest = await treeDigestOptional(backup);
  const stagePrefix = `.app-server-types.stage-${marker.pathToken}-`;

  if (marker.state === "prepared") {
    if (marker.hadOldDestination) {
      if (
        destinationDigest === marker.oldDigest &&
        backupDigest === null &&
        (stageDigest === marker.newDigest || stageDigest === null)
      ) {
        if (stageDigest !== null) {
          await removeOwnedTree(stage, parent, stagePrefix, marker.newDigest);
        }
        await unlinkVerifiedMarker(markerPath, marker);
        await removeVerifiedMarkerTemps(tempPaths, marker);
        return;
      }
      if (
        destinationDigest === null &&
        backupDigest === marker.oldDigest &&
        stageDigest === marker.newDigest
      ) {
        await fsp.rename(backup, destination);
        await removeOwnedTree(stage, parent, stagePrefix, marker.newDigest);
        await unlinkVerifiedMarker(markerPath, marker);
        await removeVerifiedMarkerTemps(tempPaths, marker);
        return;
      }
    } else if (
      destinationDigest === null &&
      backupDigest === null &&
      (stageDigest === marker.newDigest || stageDigest === null)
    ) {
      if (stageDigest !== null) {
        await removeOwnedTree(stage, parent, stagePrefix, marker.newDigest);
      }
      await unlinkVerifiedMarker(markerPath, marker);
      await removeVerifiedMarkerTemps(tempPaths, marker);
      return;
    }
    throw new Error("Prepared transaction does not match a recoverable boundary.");
  }

  if (marker.state === "old_moved") {
    if (marker.hadOldDestination) {
      if (
        destinationDigest === null &&
        backupDigest === marker.oldDigest &&
        stageDigest === marker.newDigest
      ) {
        await fsp.rename(backup, destination);
        await removeOwnedTree(stage, parent, stagePrefix, marker.newDigest);
        await unlinkVerifiedMarker(markerPath, marker);
        await removeVerifiedMarkerTemps(tempPaths, marker);
        return;
      }
      if (
        destinationDigest === marker.oldDigest &&
        backupDigest === null &&
        (stageDigest === marker.newDigest || stageDigest === null)
      ) {
        if (stageDigest !== null) {
          await removeOwnedTree(stage, parent, stagePrefix, marker.newDigest);
        }
        await unlinkVerifiedMarker(markerPath, marker);
        await removeVerifiedMarkerTemps(tempPaths, marker);
        return;
      }
    } else if (
      destinationDigest === null &&
      backupDigest === null &&
      stageDigest === marker.newDigest
    ) {
      await fsp.rename(stage, destination);
      const previous = marker;
      marker = markerWithState(marker, "new_published");
      await writeMarker(markerPath, marker, {
        expectedPrevious: previous
      });
      await finishPublishedRecovery({
        marker,
        markerPath,
        destination,
        parent,
        stage,
        backup,
        tempPaths,
        lock
      });
      return;
    }

    if (
      destinationDigest === marker.newDigest &&
      stageDigest === null &&
      (!marker.hadOldDestination
        ? backupDigest === null
        : backupDigest === marker.oldDigest)
    ) {
      const previous = marker;
      marker = markerWithState(marker, "new_published");
      await writeMarker(markerPath, marker, {
        expectedPrevious: previous
      });
      await finishPublishedRecovery({
        marker,
        markerPath,
        destination,
        parent,
        stage,
        backup,
        tempPaths,
        lock
      });
      return;
    }
    throw new Error("Old-moved transaction does not match a recoverable boundary.");
  }

  if (marker.state === "new_published" || marker.state === "committed") {
    await finishPublishedRecovery({
      marker,
      markerPath,
      destination,
      parent,
      stage,
      backup,
      tempPaths,
      lock
    });
    return;
  }

  throw new Error("Unsupported transaction state.");
}

async function recoverExistingTransaction({
  root,
  destination,
  parent,
  markerPath,
  lock
}) {
  let tempPaths = await listMarkerTemps(parent, markerPath);
  let markerStats = await lstatOptional(markerPath);

  if (!markerStats && tempPaths.length > 0) {
    if (tempPaths.length !== 1) {
      throw new Error("Multiple orphan transaction marker temps require manual review.");
    }
    const orphanMarker = await readMarkerFile(tempPaths[0]);
    validateMarker(orphanMarker, root, destination, parent, lock);
    if (orphanMarker.state !== "prepared") {
      throw new Error("Orphan marker temp is not an initial prepared marker.");
    }
    await fsp.rename(tempPaths[0], markerPath);
    markerStats = await fsp.lstat(markerPath);
    tempPaths = [];
  }

  if (!markerStats) {
    return;
  }
  if (markerStats.isSymbolicLink() || !markerStats.isFile()) {
    throw new Error("Transaction marker path is not an ordinary file.");
  }

  const marker = await readMarkerFile(markerPath);
  validateMarker(marker, root, destination, parent, lock);
  for (const tempPath of tempPaths) {
    const tempMarker = await readMarkerFile(tempPath);
    validateMarker(tempMarker, root, destination, parent, lock);
    const stateDelta =
      STATES.indexOf(tempMarker.state) - STATES.indexOf(marker.state);
    if (!sameTransaction(marker, tempMarker) || stateDelta !== 1) {
      throw new Error("Orphan marker temp is not the next state of the active transaction.");
    }
  }

  await recoverMarker({
    root,
    destination,
    parent,
    markerPath,
    marker,
    tempPaths,
    lock
  });
}

async function recoverPreMarkerArtifacts(parent, lock) {
  const stagePrefix = `.app-server-types.stage-${lock.owner.pathToken}-`;
  const backupPrefix = `.app-server-types.backup-${lock.owner.pathToken}`;
  const names = await fsp.readdir(parent);
  const stages = names
    .filter((name) => name.startsWith(stagePrefix))
    .map((name) => path.join(parent, name));
  const backups = names.filter((name) => name.startsWith(backupPrefix));

  if (backups.length > 0 || stages.length > 1) {
    throw new Error("Marker-less transaction artifacts require manual review.");
  }
  if (stages.length === 1) {
    await removeOwnedTree(stages[0], parent, stagePrefix);
  }
}

async function recoverUnderLock({
  root,
  destination,
  parent,
  markerPath,
  lock
}) {
  await recoverExistingTransaction({
    root,
    destination,
    parent,
    markerPath,
    lock
  });
  if (await lstatOptional(markerPath)) {
    throw new Error("Transaction recovery did not clear the marker.");
  }
  if ((await listMarkerTemps(parent, markerPath)).length > 0) {
    throw new Error("Transaction recovery left orphan marker temps.");
  }
  await recoverPreMarkerArtifacts(parent, lock);
}

function makeMarker({
  root,
  destination,
  stage,
  backup,
  lock,
  transactionId,
  hadOldDestination,
  oldDigest,
  newDigest
}) {
  return {
    schemaVersion: 1,
    owner: OWNER,
    ownerPid: lock.owner.pid,
    lockToken: lock.owner.token,
    pathToken: lock.owner.pathToken,
    transactionId,
    state: "prepared",
    destination: toMarkerPath(root, destination),
    stage: toMarkerPath(root, stage),
    backup: toMarkerPath(root, backup),
    hadOldDestination,
    oldDigest,
    newDigest
  };
}

async function prepareTransactionRoot(repoRoot) {
  const root = path.resolve(repoRoot);
  const destination = path.resolve(root, ...GENERATED_TYPES_RELATIVE.split("/"));
  if (!isInside(root, destination)) {
    throw new Error("Generated schema destination escapes the repository.");
  }
  const parent = path.dirname(destination);
  await assertSafeExistingComponents(root, parent);
  await fsp.mkdir(parent, { recursive: true });
  await assertSafeExistingComponents(root, parent);
  return {
    root,
    destination,
    parent,
    markerPath: path.join(parent, MARKER_NAME)
  };
}

export async function recoverGeneratedAppServerTypes({
  repoRoot,
  onBoundary = null
}) {
  const context = await prepareTransactionRoot(repoRoot);
  const requestRunId = `recovery-${randomUUID()}`;
  const lock = await acquireTransactionLock(
    context.parent,
    requestRunId,
    onBoundary
  );
  const createdFreshLock = !lock.recovery;

  try {
    if (lock.recovery) {
      await recoverUnderLock({ ...context, lock });
    } else {
      const markerExists = await lstatOptional(context.markerPath);
      const markerTemps = await listMarkerTemps(
        context.parent,
        context.markerPath
      );
      if (markerExists || markerTemps.length > 0) {
        throw new Error("A transaction marker exists without its matching lock.");
      }
    }
    return {
      destination: context.destination,
      digest: await treeDigestOptional(context.destination),
      recovered: lock.recovery
    };
  } finally {
    if (
      createdFreshLock ||
      !(await lstatOptional(context.markerPath))
    ) {
      await releaseTransactionLock(lock, onBoundary);
    }
  }
}

export async function publishGeneratedAppServerTypes({
  repoRoot,
  generate,
  validate,
  runId = randomUUID(),
  onBoundary = null
}) {
  if (typeof generate !== "function") {
    throw new TypeError("generate must be a function.");
  }
  if (typeof validate !== "function") {
    throw new TypeError("validate must be a function.");
  }
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error("runId contains unsupported characters.");
  }

  const { root, destination, parent, markerPath } =
    await prepareTransactionRoot(repoRoot);
  let lock = await acquireTransactionLock(parent, runId, onBoundary);
  if (lock.recovery) {
    try {
      await recoverUnderLock({
        root,
        destination,
        parent,
        markerPath,
        lock
      });
    } finally {
      if (!(await lstatOptional(markerPath))) {
        await releaseTransactionLock(lock, onBoundary);
      }
    }
    lock = await acquireTransactionLock(parent, runId, onBoundary);
  }

  if (await lstatOptional(markerPath)) {
    await releaseTransactionLock(lock, onBoundary);
    throw new Error("A transaction marker exists without its matching lock.");
  }

  const stagePrefix = `.app-server-types.stage-${lock.owner.pathToken}-`;
  const backupPrefix = `.app-server-types.backup-${lock.owner.pathToken}`;
  const backup = path.join(parent, backupPrefix);
  let stage = null;

  try {
    stage = await fsp.mkdtemp(path.join(parent, stagePrefix));
    await generate(stage);
    await validate(stage);
    const newDigest = await digestGeneratedTree(stage, {
      requireTypeScript: true
    });

    const destinationStats = await lstatOptional(destination);
    let hadOldDestination = false;
    let oldDigest = null;
    if (destinationStats) {
      if (destinationStats.isSymbolicLink() || !destinationStats.isDirectory()) {
        throw new Error(
          "Generated schema destination is a link, reparse redirect, or non-directory."
        );
      }
      const canonical = await fsp.realpath(destination);
      if (!samePath(canonical, destination)) {
        throw new Error(
          "Generated schema destination resolves through a link or reparse redirect."
        );
      }
      hadOldDestination = true;
      oldDigest = await digestGeneratedTree(destination);
    }

    let marker = makeMarker({
      root,
      destination,
      stage,
      backup,
      lock,
      transactionId: runId,
      hadOldDestination,
      oldDigest,
      newDigest
    });
    await writeMarker(markerPath, marker, {
      onBoundary,
      expectedPrevious: null
    });
    if (onBoundary) {
      await onBoundary("after_marker_prepared", { state: marker.state });
    }

    if (hadOldDestination) {
      await assertMarkerEquals(markerPath, marker);
      if (onBoundary) {
        await onBoundary("before_old_rename", { state: marker.state });
      }
      await fsp.rename(destination, backup);
      if (onBoundary) {
        await onBoundary("after_old_rename_before_marker", {
          state: marker.state
        });
      }
    }

    {
      const previous = marker;
      marker = markerWithState(marker, "old_moved");
      await writeMarker(markerPath, marker, {
        onBoundary,
        expectedPrevious: previous
      });
    }
    if (onBoundary) {
      await onBoundary("after_marker_old_moved", { state: marker.state });
      await onBoundary("before_new_rename", { state: marker.state });
    }

    await assertMarkerEquals(markerPath, marker);
    await fsp.rename(stage, destination);
    if (onBoundary) {
      await onBoundary("after_new_rename_before_marker", {
        state: marker.state
      });
    }

    {
      const previous = marker;
      marker = markerWithState(marker, "new_published");
      await writeMarker(markerPath, marker, {
        onBoundary,
        expectedPrevious: previous
      });
    }
    if (onBoundary) {
      await onBoundary("after_marker_new_published", { state: marker.state });
    }

    if (hadOldDestination) {
      await assertMarkerEquals(markerPath, marker);
      if (onBoundary) {
        await onBoundary("before_backup_remove", { state: marker.state });
      }
      await removeOwnedTree(backup, parent, backupPrefix, oldDigest);
      if (onBoundary) {
        await onBoundary("after_backup_remove_before_marker", {
          state: marker.state
        });
      }
    }

    {
      const previous = marker;
      marker = markerWithState(marker, "committed");
      await writeMarker(markerPath, marker, {
        onBoundary,
        expectedPrevious: previous
      });
    }
    if (onBoundary) {
      await onBoundary("after_marker_committed", { state: marker.state });
    }
    await unlinkVerifiedMarker(markerPath, marker);
    return { destination, digest: newDigest };
  } catch (error) {
    try {
      await recoverExistingTransaction({
        root,
        destination,
        parent,
        markerPath,
        lock
      });
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        `Schema publish failed and recovery stopped fail-closed: ${
          error instanceof Error ? error.message : String(error)
        }; recovery: ${
          recoveryError instanceof Error
            ? recoveryError.message
            : String(recoveryError)
        }`
      );
    }
    throw error;
  } finally {
    if (
      stage &&
      !(await lstatOptional(markerPath)) &&
      (await lstatOptional(stage))
    ) {
      await removeOwnedTree(stage, parent, stagePrefix);
    }
    if (
      !(await lstatOptional(markerPath)) &&
      (!stage || !(await lstatOptional(stage)))
    ) {
      await releaseTransactionLock(lock, onBoundary);
    }
  }
}
