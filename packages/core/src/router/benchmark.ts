// ═══════════════════════════════════════════════════════════════════════════
// BENCHMARKING & PROFILING UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

import type { RouterContext } from ".";
import type { RadixEngine } from "./engine";
function percentileFromSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx]!;
}

/**
 * Reservoir sampler for latency samples.
 * Keeps a uniform sample of all seen values with fixed memory.
 */
class Reservoir {
  private buf: number[];
  private size: number;
  private seen: number;

  constructor(size: number) {
    this.buf = new Array(size);
    this.size = size;
    this.seen = 0;
  }

  push(v: number) {
    const i = this.seen++;
    if (i < this.size) {
      this.buf[i] = v;
      return;
    }
    // Vitter's Algorithm R
    const j = (Math.random() * (i + 1)) | 0;
    if (j < this.size) this.buf[j] = v;
  }

  values(): number[] {
    const n = Math.min(this.seen, this.size);
    // slice to actual length
    return this.buf.slice(0, n);
  }
}

export class RouterBenchmark {
  /**
   * Measure raw throughput with high precision.
   *
   * Changes vs original:
   * - No longer stores 1M latencies (fixes heap blow-up).
   * - Uses reservoir sampling (default 8192 samples) for percentiles.
   * - Avoids `await` for non-Gemini routers (reduces async overhead/noise).
   */
  static async measureFindThroughput<C extends RouterContext>(
    router: RadixEngine<unknown>,
    requests: Array<{ method: string; path: string }>,
    iterations = 1_000_000,
    opts?: { warmupIterations?: number; sampleSize?: number }
  ): Promise<{
    opsPerSec: number;
    avgLatencyNs: number;
    minLatencyNs: number;
    maxLatencyNs: number;
    p50Ns: number;
    p95Ns: number;
    p99Ns: number;
  }> {
    const warmupIterations = opts?.warmupIterations ?? 10_000;
    const sampleSize = opts?.sampleSize ?? 8192;

    let minLatency = Infinity;
    let maxLatency = 0;

    const reservoir = new Reservoir(sampleSize);

    // Warmup (JIT compilation)
    for (let i = 0; i < warmupIterations; i++) {
      const req = requests[i % requests.length];
      if (!req) continue;
      try {
        // Most engines' find() is sync boolean; don't await.
        (router as any).search(req.path);
      } catch {
        // ignore
      }
    }

    const startTime = Bun.nanoseconds();

    for (let i = 0; i < iterations; i++) {
      const req = requests[i % requests.length];
      if (!req) continue;

      const iterStart = Bun.nanoseconds();
      try {
        (router as any).search(req.path);
      } catch {
        // ignore
      }
      const iterEnd = Bun.nanoseconds();

      const latency = iterEnd - iterStart;
      reservoir.push(latency);
      if (latency < minLatency) minLatency = latency;
      if (latency > maxLatency) maxLatency = latency;
    }


    const endTime = Bun.nanoseconds();
    const totalNs = endTime - startTime;
    const avgLatencyNs = totalNs / iterations;
    const opsPerSec = (iterations / totalNs) * 1e9;

    // Percentiles from sample
    const sample = reservoir.values();
    sample.sort((a, b) => a - b);

    return {
      opsPerSec,
      avgLatencyNs,
      minLatencyNs: minLatency === Infinity ? 0 : minLatency,
      maxLatencyNs: maxLatency,
      p50Ns: percentileFromSorted(sample, 0.50),
      p95Ns: percentileFromSorted(sample, 0.95),
      p99Ns: percentileFromSorted(sample, 0.99)
    };
  }

  /**
   * Memory profiling
   *
   * Change vs original:
   * - Avoids `await` for non-Gemini routers.
   * - Uses globalThis.gc when available.
   */
  static async profileMemory<C extends RouterContext>(
    router: RadixEngine<unknown>,
    requests: Array<{ method: string; path: string }>,
    iterations = 100_000
  ): Promise<{
    heapUsedBefore: number;
    heapUsedAfter: number;
    heapGrowth: number;
  }> {
    // Force GC if available (Bun may not expose this unless launched accordingly)
    const gc = (globalThis as any).gc as undefined | (() => void);
    if (gc) gc();

    const heapBefore = process.memoryUsage().heapUsed;

    for (let i = 0; i < iterations; i++) {
      const req = requests[i % requests.length];
      if (!req) continue;
      try {
        (router as any).search(req.path);
      } catch {
        // ignore
      }
    }

    if (gc) gc();

    const heapAfter = process.memoryUsage().heapUsed;

    return {
      heapUsedBefore: heapBefore,
      heapUsedAfter: heapAfter,
      heapGrowth: heapAfter - heapBefore
    };
  }
}