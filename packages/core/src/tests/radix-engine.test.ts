import { beforeAll, describe, expect, test } from "bun:test";
import { RadixEngine, type SearchResult } from "../router/engine";

const MAX_PARAMS = 8;

type Ctx = { hit?: boolean; params?: Record<string, string> };

type Match<T> =
  | { found: true; value: T; params: Record<string, string> }
  | { found: false }

function matchRoute<T>(
  engine: { searchInto(path: string, pool: Uint32Array, out: SearchResult<T>): boolean; getParamKeysForNode(nodeIndex: number): string[] },
  path: string,
  pool: Uint32Array,
  out: SearchResult<T>,
): Match<T> {
  const ok = engine.searchInto(path, pool, out);
  if (!ok || !out.found) return { found: false };

  const value = out.value as T;
  const paramCount = (out.paramCount || 0) as number;

  if (paramCount === 0) {
    // Avoid allocating params object.
    return { found: true, value, params: Object.create(null) };
    // If you want truly no params allocation in this case:
    // return { found: true, value, params: EMPTY_PARAMS }; (shared frozen empty object)
  }

  const nodeIndex = out.nodeIndex as number;
  const keys = engine.getParamKeysForNode(nodeIndex); // allocates array (OK, not during search)

  // Assemble params (allocates object + substrings; allowed in final phase)
  const params: Record<string, string> = Object.create(null);
  for (let i = 0; i < paramCount; i++) {
    const start = pool[(i << 1)] || 0;
    const end = pool[(i << 1) + 1] || 0;
    params[keys[i]!] = path.substring(start, end);
  }

  return { found: true, value, params };
}

const noopAsync = async () => {};
const capture =
  (label: string) => label

describe("RadixEngine – route matching & params", () => {
  let engine: RadixEngine<unknown>;

  beforeAll(() => {
    engine = new RadixEngine({ assumeAscii: true });

    engine.insertBatch([
      ["/api/health", capture("health")],
      ["/api/metrics", capture("metrics")],
      ["/api/version", capture("version")],

      ["/api/users/{id}", capture("user")],
      ["/api/posts/{id}", capture("post")],
      ["/api/products/{id}", capture("product")],

      [
        "/api/users/{userId}/posts/{postId}",
        capture("user-post"),
      ],
      [
        "/api/orgs/{orgId}/repos/{repoId}/issues/{issueId}",
        capture("issue"),
      ],

      ["/api/files/{name}.{ext}", capture("file")],
      ["/api/v{version}/users/{id}", capture("versioned-user")],

      ["/static/*", capture("static")],
      ["/assets/*", capture("assets")],
    ]);
  });

  test("static route matches", () => {
    const pool = new Uint32Array(MAX_PARAMS * 2); // choose based on your route set
    const out: SearchResult<any> = { found: false };
    const result = matchRoute<typeof out>(engine, "/api/health", pool, out);

    console.log(result);

    expect(result.found).toBe(true);
    expect((result as any).value).toBe("health");
  });

  test("single param route", () => {
    const pool = new Uint32Array(MAX_PARAMS * 2); // choose based on your route set
    const out: SearchResult<typeof capture> = Object.create(null);
    const result = matchRoute<typeof capture>(engine, "/api/users/123", pool, out);

    console.log(result);

    expect(result.found).toBe(true);
    expect((result as any).value).toBe("user");
    expect((result as any).params).toEqual({ id: "123" });
  });

  test("multi param route", () => {
    const pool = new Uint32Array(MAX_PARAMS * 2); // choose based on your route set
    const out: SearchResult<typeof capture> = Object.create(null);
    const result = matchRoute<typeof capture>(engine, "/api/users/456/posts/789", pool, out);

    expect(result.found).toBe(true);
    expect((result as any).value).toBe("user-post");
    expect((result as any).params).toEqual({
      userId: "456",
      postId: "789",
    });

  });

  test("deep multi param route", () => {
    const pool = new Uint32Array(MAX_PARAMS * 2); // choose based on your route set
    const out: SearchResult<typeof capture> = Object.create(null);
    const result = matchRoute<typeof capture>(engine, "/api/orgs/acme/repos/aether/issues/42", pool, out);

    expect(result.found).toBe(true);
    expect((result as any).value).toBe("issue");
    expect((result as any).params).toEqual({
      orgId: "acme",
      repoId: "aether",
      issueId: "42",
    });
  });

  test("dot-delimited params", () => {
    const pool = new Uint32Array(MAX_PARAMS * 2); // choose based on your route set
    const out: SearchResult<typeof capture> = Object.create(null);
    const result = matchRoute<typeof capture>(engine, "/api/files/document.pdf", pool, out);

    expect(result.found).toBe(true);
    expect((result as any).value).toBe("file");
    expect((result as any).params).toEqual({
      name: "document",
      ext: "pdf",
    });
  });

  test("inline param (v{version})", () => {
    const pool = new Uint32Array(MAX_PARAMS * 2); // choose based on your route set
    const out: SearchResult<typeof capture> = Object.create(null);
    const result = matchRoute<typeof capture>(engine, "/api/v2/users/99", pool, out);

    expect(result.found).toBe(true);
    expect((result as any).value).toBe("versioned-user");
    expect((result as any).params).toEqual({
      version: "2",
      id: "99",
    });
  });

  test("wildcard route", () => {
    const pool = new Uint32Array(MAX_PARAMS * 2); // choose based on your route set
    const out: SearchResult<typeof capture> = Object.create(null);
    const result = matchRoute<typeof capture>(engine, "/static/images/logo.png", pool, out);

    expect(result.found).toBe(true);
    expect((result as any).value).toBe("static");
  });

  test("find() returns false for no match", () => {
    const pool = new Uint32Array(MAX_PARAMS * 2); // choose based on your route set
    const out = { found: false };
    const result = engine.searchInto("/does/not/exist", pool, out);
    expect(result).toBe(false);
  });
});
