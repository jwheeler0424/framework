// ═══════════════════════════════════════════════════════════════════════════
// PARAMETER CACHE FOR COMMON PATTERNS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Inline cache for parameter extraction patterns
 * Caches the compiled extraction function for each route
 */
export type ParamExtractor = (path: string, pool: Uint32Array, poolPtr: number) => Record<string, string>;

export class ParamExtractionCache {
  private cache: Map<string, ParamExtractor>;
  private maxSize: number;

  constructor(maxSize = 1000) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  /**
   * Generate extraction function for specific parameter pattern
   * This creates a specialized function that's JIT-friendly
   */
  getOrCreate(paramKeys: string[]): ParamExtractor {
    const cacheKey = paramKeys.join('|');

    let extractor = this.cache.get(cacheKey);
    if (extractor) return extractor;

    // Generate specialized extractor based on param count
    switch (paramKeys.length) {
      case 0:
        extractor = this.makeExtractor0();
        break;
      case 1:
        extractor = this.makeExtractor1(String(paramKeys[0]));
        break;
      case 2:
        extractor = this.makeExtractor2(String(paramKeys[0]), String(paramKeys[1]));
        break;
      case 3:
        extractor = this.makeExtractor3(String(paramKeys[0]), String(paramKeys[1]), String(paramKeys[2]));
        break;
      default:
        extractor = this.makeExtractorN(paramKeys);
    }

    if (this.cache.size < this.maxSize) {
      this.cache.set(cacheKey, extractor);
    }

    return extractor;
  }

  private makeExtractor0(): ParamExtractor {
    // Monomorphic return shape
    const emptyParams = Object.create(null);
    return () => emptyParams;
  }

  private makeExtractor1(key0: string): ParamExtractor {
    return (path: string, pool: Uint32Array, poolPtr: number) => {
      const params = Object.create(null);
      params[key0] = path.substring(pool[0]!, pool[1]);
      return params;
    };
  }

  private makeExtractor2(key0: string, key1: string): ParamExtractor {
    return (path: string, pool: Uint32Array, poolPtr: number) => {
      const params = Object.create(null);
      params[key0] = path.substring(pool[0]!, pool[1]);
      params[key1] = path.substring(pool[2]!, pool[3]);
      return params;
    };
  }

  private makeExtractor3(key0: string, key1: string, key2: string): ParamExtractor {
    return (path: string, pool: Uint32Array, poolPtr: number) => {
      const params = Object.create(null);
      params[key0] = path.substring(pool[0]!, pool[1]);
      params[key1] = path.substring(pool[2]!, pool[3]);
      params[key2] = path.substring(pool[4]!, pool[5]);
      return params;
    };
  }

  private makeExtractorN(keys: string[]): ParamExtractor {
    const keyCount = keys.length;
    return (path: string, pool: Uint32Array, poolPtr: number) => {
      const params = Object.create(null);
      let poolIdx = 0;
      for (let i = 0; i < keyCount; i++) {
        params[keys[i]!] = path.substring(pool[poolIdx++]!, pool[poolIdx++]!);
      }
      return params;
    };
  }

  clear(): void {
    this.cache.clear();
  }
}