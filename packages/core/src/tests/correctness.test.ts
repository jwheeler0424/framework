import { beforeEach, describe, expect, it } from "bun:test";
import { PatternMachine } from "../router";

describe("PatternMachine Correctness", () => {
  let machine: PatternMachine<string>;

  beforeEach(() => {
    machine = new PatternMachine({
      delimiter: "/",
      caseSensitive: true,
    });
  });

  it("matches exact static strings", () => {
    machine.add("api/v1/status", "STATUS");
    const res = machine.match("api/v1/status");
    expect(res).toHaveLength(1);
    expect(res[0]?.data).toBe("STATUS");
  });

  it("matches parameters and extracts values", () => {
    machine.add("users/{id}", "USER_DETAIL");
    const res = machine.match("users/123");
    expect(res).toHaveLength(1);
    expect(res[0]?.params["id"]).toBe("123");
  });

  it("handles multiple concurrent matches (ambiguity)", () => {
    // This is the "Blazing Fast" secret sauce: handling overlaps
    machine.add("files/special.jpg", "EXACT_FILE");
    machine.add("files/{name}", "GENERIC_FILE");
    machine.add("files/*", "WILDCARD_FILE");

    const res = machine.match("files/special.jpg");

    // Should match ALL of them
    expect(res).toHaveLength(3);
    const data = res.map((r) => r.data).sort();
    expect(data).toEqual(["EXACT_FILE", "GENERIC_FILE", "WILDCARD_FILE"]);
  });

  it("respects parameter length limits", () => {
    machine = new PatternMachine({ maxParamLength: 5 });
    machine.add("lookup/{code}", "LOOKUP");

    const short = machine.match("lookup/12345");
    expect(short).toHaveLength(1);

    const long = machine.match("lookup/123456");
    expect(long).toHaveLength(0); // Should fail to match param
  });

  it("respects execution limits (EXCEDED)", () => {
    machine = new PatternMachine({ executionLimit: 2 });
    machine.add("a/b", "SHALLOW");
    machine.add("a/b/c/d/e", "DEEP");

    // This path is 5 levels deep. Limit is 2.
    // It should hit the limit and stop.
    // Note: Console.warn will trigger
    const res = machine.match("a/b/c/d/e");
    expect(res).toHaveLength(0);
  });

  it("respects execution limits", () => {
    machine = new PatternMachine({ executionLimit: 2 });
    machine.add("a/b/c/d/e", "DEEP");

    // This path is 1 level deep. Limit is 2.
    // It should hit the limit and stop.
    // Note: Console.warn will trigger
    const res = machine.match("a/b/c/d/e");
    expect(res).toHaveLength(1);
  });

  it("normalizes inputs (trailing slash & duplicate slashes)", () => {
    machine = new PatternMachine({
      ignoreTrailingDelimiter: true,
      ignoreDuplicateDelimiter: true,
    });
    machine.add("home/profile", "PROFILE");

    // Messy input
    const res = machine.match("home//profile/");
    expect(res).toHaveLength(1);
    expect(res[0]?.data).toBe("PROFILE");
  });
});
