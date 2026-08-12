import {
  isRecordedParentAlive,
  readOwnershipRecord,
  reclaimOwnedProcess,
} from "./controlled-browser-process.mjs";

const [registryPath, terminationGraceValue, cleanupTimeoutValue] = process.argv.slice(2);
if (!registryPath) process.exit(64);

const terminationGraceMs = Number(terminationGraceValue) || 2_000;
const cleanupTimeoutMs = Number(cleanupTimeoutValue) || 2_000;

for (;;) {
  let record;
  try {
    record = await readOwnershipRecord(registryPath);
  } catch {
    process.exit(0);
  }
  if (record.state !== "active" && record.state !== "closing" && record.state !== "root_exited") process.exit(0);
  if (!(await isRecordedParentAlive(record))) {
    try {
      await reclaimOwnedProcess(registryPath, { terminationGraceMs, cleanupTimeoutMs });
      process.exit(0);
    } catch {
      process.exit(1);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
