import { describe, expect, it } from "bun:test";
import { PatternMachine } from "../router";

describe("PatternMachine Serialization", () => {
  it("should survive a freeze/thaw cycle", () => {
    // 1. Build Original
    const original = new PatternMachine<string>({ delimiter: "#" });
    original.add("users#list", "USERS");
    original.add("files#**", "ALL_FILES");

    // 2. Serialize
    const json = JSON.stringify(original.toJSON());

    // 3. Hydrate into NEW instance
    const loaded = PatternMachine.fromJSON<string>(JSON.parse(json));

    // 4. Verify functionality matches
    const res1 = loaded.match("users#list");
    expect(res1).toHaveLength(1);
    expect(res1[0]?.data).toBe("USERS");

    const res2 = loaded.match("files#images#logo.png");
    expect(res2).toHaveLength(1);
    expect(res2[0]?.data).toBe("ALL_FILES");

    // 5. Verify Config persisted
    // @ts-ignore - accessing private config for test
    expect(loaded.config.delimiter).toBe("#");
  });
});
