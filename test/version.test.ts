import { describe, expect, it } from "vitest";
import packageJson from "../package.json";
import { SDK_VERSION } from "../src/version.js";

describe("SDK_VERSION", () => {
  it("matches package.json version", () => {
    expect(SDK_VERSION).toBe(packageJson.version);
  });
});
