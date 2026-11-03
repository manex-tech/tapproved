import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectTestnetPreflight } from "../relay/testnet-preflight.js";

const NEWLINE = String.fromCharCode(10);

function readOutputPath(argv) {
  const index = argv.indexOf("--output");
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--output requires a file path");
  }
  return value;
}

export function serializePreflightSnapshot(snapshot) {
  return JSON.stringify(snapshot, null, 2) + NEWLINE;
}

export async function main(argv = process.argv.slice(2)) {
  const snapshot = await collectTestnetPreflight();
  const serialized = serializePreflightSnapshot(snapshot);
  const outputPath = readOutputPath(argv);

  if (outputPath) {
    const target = resolve(outputPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, serialized, { encoding: "utf8", flag: "wx" });
    process.stdout.write(`Read-only preflight snapshot saved to ${target}${NEWLINE}`);
  } else {
    process.stdout.write(serialized);
  }

  if (!snapshot.ready_for_upgrade) {
    process.stderr.write(`Preflight blocked by ${snapshot.blockers.length} finding(s). Do not upgrade the contract.${NEWLINE}`);
    process.exitCode = 2;
  } else {
    process.stderr.write("Preflight passed its structural checks. Review storage funding and warnings before deployment." + NEWLINE);
  }
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Tapproved Testnet preflight failed: ${error.message}${NEWLINE}`);
    process.exitCode = 1;
  });
}
