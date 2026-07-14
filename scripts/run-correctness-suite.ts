import { execSync } from "child_process";
import { redis } from "../src/lib/redis";

async function runOnce(runIndex: number): Promise<{ allowed: number; denied: number }> {
  console.log(`\n--- [RUN ${runIndex}] Cleaning Redis state for client-hot-tb ---`);
  if (!redis.isOpen) {
    await redis.connect();
  }
  await redis.del("bucket:client-hot-tb");
  console.log(`Deleted Redis key 'bucket:client-hot-tb'`);

  console.log(`Executing k6 concurrency test for run ${runIndex}...`);
  const stdout = execSync("./bin/k6 run load-tests/rate-limit-correctness.js", { encoding: "utf-8" });
  
  // Parse allowed_requests and denied_requests from stdout
  // k6 outputs custom counters in format: allowed_requests...............: 100    9.999/s
  const allowedMatch = stdout.match(/allowed_requests\.+:\s*(\d+)/);
  const deniedMatch = stdout.match(/denied_requests\.+:\s*(\d+)/);

  const allowed = allowedMatch ? parseInt(allowedMatch[1], 10) : 0;
  const denied = deniedMatch ? parseInt(deniedMatch[1], 10) : 0;

  console.log(`[RUN ${runIndex} RESULTS] Allowed: ${allowed}, Denied: ${denied}`);
  return { allowed, denied };
}

async function main() {
  console.log("Starting Correctness Proof Suite (5 iterations)...");
  
  const results: Array<{ run: number; allowed: number; denied: number; passed: boolean }> = [];
  
  for (let i = 1; i <= 5; i++) {
    try {
      const { allowed, denied } = await runOnce(i);
      const passed = allowed === 100 && denied === 900;
      results.push({ run: i, allowed, denied, passed });
    } catch (err) {
      console.error(`Error in run ${i}:`, err);
      results.push({ run: i, allowed: 0, denied: 0, passed: false });
    }
  }

  console.log("\n=================================");
  console.log("   CORRECTNESS SUITE SUMMARY     ");
  console.log("=================================");
  let allPassed = true;
  for (const r of results) {
    console.log(`Run ${r.run}: ${r.passed ? "PASSED" : "FAILED"} (Allowed: ${r.allowed}/100, Denied: ${r.denied}/900)`);
    if (!r.passed) {
      allPassed = false;
    }
  }
  
  if (allPassed) {
    console.log("\nSUCCESS: All 5 correctness runs passed perfectly!");
    process.exit(0);
  } else {
    console.error("\nFAILURE: One or more correctness runs failed.");
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error("Suite execution failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    if (redis.isOpen) {
      await redis.quit();
    }
  });
