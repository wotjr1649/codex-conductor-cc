import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  publishGeneratedAppServerTypes,
  recoverGeneratedAppServerTypes
} from "../scripts/lib/generated-tree-transaction.mjs";

const [repoRoot, crashBoundary, crashState = "", operation = "publish"] =
  process.argv.slice(2);
if (!repoRoot || !crashBoundary) {
  throw new Error("Expected repo root and crash boundary.");
}

const onBoundary = async (boundary, details) => {
  if (
    boundary === crashBoundary &&
    (!crashState || details.state === crashState)
  ) {
    process.exit(86);
  }
};

if (operation === "recover") {
  await recoverGeneratedAppServerTypes({ repoRoot, onBoundary });
  process.exit(0);
}

await publishGeneratedAppServerTypes({
  repoRoot,
  runId: "crash-fixture",
  generate: async (outputDirectory) => {
    fs.mkdirSync(path.join(outputDirectory, "nested"), { recursive: true });
    fs.writeFileSync(
      path.join(outputDirectory, "index.ts"),
      "export type Generated = { value: string };\n"
    );
    fs.writeFileSync(
      path.join(outputDirectory, "nested", "types.ts"),
      "export type Nested = number;\n"
    );
  },
  validate: async () => {},
  onBoundary
});
