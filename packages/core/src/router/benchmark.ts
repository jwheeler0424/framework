import { performance } from "perf_hooks";

// =========================================================
// 1. INCLUDE THE PATTERN MACHINE CODE (Simplified for Bench)
// =========================================================
import { PatternMachine } from "./machine";

// =========================================================
// 2. THE COMPETITOR (Standard Regex Loop)
// =========================================================
class RegexRouter {
  routes: { regex: RegExp; id: string }[] = [];

  add(pattern: string, id: string) {
    // Convert /users/{id} -> ^/users/([^/]+)$
    let r = pattern
      .replace(/\//g, "\\/")
      .replace(/{([^}]+)}/g, "([^/]+)")
      .replace(/\*/g, ".*");
    this.routes.push({ regex: new RegExp(`^${r}$`), id });
  }

  match(input: string) {
    for (const route of this.routes) {
      const match = route.regex.exec(input);
      if (match) return [{ data: route.id, params: match.slice(1) }];
    }
    return [];
  }
}

// =========================================================
// 3. GENERATE LOAD
// =========================================================
console.log("Generating 1,000 patterns...");

const machine = new PatternMachine<string>();
const regexRouter = new RegexRouter();
const sampleInputs: string[] = [];

// Create 1000 routes: /api/v1/resource-N/{id}/action
for (let i = 0; i < 1000; i++) {
  const pattern = `/api/v1/resource-${i}/{id}/action`;
  machine.add(pattern, `route-${i}`);
  regexRouter.add(pattern, `route-${i}`);

  if (i % 100 === 0) sampleInputs.push(`/api/v1/resource-${i}/abc-123/action`);
}

// Add a wildcard at the end
machine.add("/static/*", "wildcard");
regexRouter.add("/static/*", "wildcard");
sampleInputs.push("/static/file.png");

// Add a pure static
machine.add("/health", "health");
regexRouter.add("/health", "health");
sampleInputs.push("/health");

console.log(
  `Setup complete. Routes: 1002. Sample inputs: ${sampleInputs.length}`,
);

// =========================================================
// 4. RUN BENCHMARK
// =========================================================

function benchmark(name: string, fn: () => void) {
  const start = performance.now();
  const iterations = 50_000;

  for (let i = 0; i < iterations; i++) {
    fn();
  }

  const end = performance.now();
  const totalTime = end - start;
  const opsPerSec = (iterations / totalTime) * 1000;

  console.log(`\n${name}`);
  console.log(`Total Time: ${totalTime.toFixed(2)}ms`);
  console.log(`Ops/Sec:    ${Math.round(opsPerSec).toLocaleString()}`);
  return opsPerSec;
}

// Warmup
console.log("\nWarming up V8...");
benchmark("Warmup (Machine)", () => machine.match(sampleInputs[0]!));
benchmark("Warmup (Regex)", () => regexRouter.match(sampleInputs[0]!));

// Actual Test
console.log("\n--- STARTING RACE ---");

const machineOps = benchmark("PatternMachine (Radix)", () => {
  for (const input of sampleInputs) machine.match(input);
});

const regexOps = benchmark("Standard Regex Loop", () => {
  for (const input of sampleInputs) regexRouter.match(input);
});

const multiplier = (machineOps / regexOps).toFixed(1);
console.log(`\n>>> RESULT: PatternMachine is ${multiplier}x FASTER <<<`);
