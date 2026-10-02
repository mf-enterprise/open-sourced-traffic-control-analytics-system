import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === "--help") {
    const usage =
      "Usage: node scripts/verify-case-speed.mjs <exported-case.json>\nUse the case detail panel's Export case record JSON. This command only reads local files.";
    if (args.length === 1 && args[0] === "--help") {
      console.log(usage);
      return;
    }
    throw new Error(usage);
  }
  const { CASE_ID, validateCaseSpeedMeasurement } =
    await import("../server/validation.mjs");
  let record;
  try {
    record = JSON.parse(await readFile(resolve(args[0]), "utf8"));
  } catch (error) {
    throw new Error(
      error instanceof SyntaxError
        ? "The case file is not valid JSON."
        : "The case file could not be read.",
    );
  }
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    typeof record.id !== "string" ||
    !CASE_ID.test(record.id) ||
    typeof record.simulation !== "boolean"
  )
    throw new Error(
      "Use the single saved record from Export case record, not an API wrapper or session export.",
    );
  const measurement = validateCaseSpeedMeasurement(record);
  if (!measurement)
    throw new Error(
      "This record has no saved speed measurement trace; its speed cannot be reconstructed.",
    );
  const start = measurement.samples[0].timeSeconds;
  const end = measurement.samples.at(-1).timeSeconds;
  console.log(
    JSON.stringify(
      {
        caseId: record.id,
        result: "numerically-consistent",
        method: measurement.method,
        recordedSpeedKmh: record.speedKmh,
        reconstructedSpeedKmh: measurement.speedKmh,
        velocityMps: measurement.velocityMps,
        mediaInterval: {
          startSeconds: start,
          endSeconds: end,
          spanSeconds: end - start,
          evidenceFrameSeconds: record.sourceTimestamp,
          finalSampleLagSeconds: record.sourceTimestamp - end,
        },
        sampleCount: measurement.samples.length,
        pairCount: measurement.pairCount,
        limitation:
          "Numerical consistency does not establish physical speed accuracy, calibration correctness, authentic observations, or legal validity. The exported JSON is not cryptographically authenticated, and this command does not inspect its evidence image.",
      },
      null,
      2,
    ),
  );
}
try {
  await main();
} catch (error) {
  console.error(`Speed verification failed: ${error.message}`);
  process.exitCode = 1;
}
