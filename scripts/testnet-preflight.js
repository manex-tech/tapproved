import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectTestnetPreflight } from "../relay/testnet-preflight.js";

function readOutputPath(argv) {
  const index = argv.indexOf("--output");
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--output requires a file path");
  }
  return value;
}

export async function main(argv = process.argv.slice(2)) {
  const snapshot = await collectTestnetPreflight();
  const serialized = `${JSON.stringify(snapshot, null, 2)}\\n`;
  const outputPath = readOutputPath(argv);

  if (outputPath) {
    const target = resolve(outputPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, serialized, { encoding: "utf8", flag: "wx" });
    process.stdout.write(`Read-only preflight snapshot saved to ${target}\\n`);
  } else {
    process.stdout.write(serialized);
  }

  if (!snapshot.ready_for_upgrade) {
    process.stderr.write(`Preflight blocked by ${snapshot.blockers.length} finding(s). Do not upgrade the contract.\\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write("Preflight passed its structural checks. Review storage funding and warnings before deployment.\\n");
  }
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Tapproved Testnet preflight failed: ${error.message}\\n`);
    process.exitCode = 1;
  });
}
