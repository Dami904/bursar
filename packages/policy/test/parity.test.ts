import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildParityFixture, fixturePath } from "../scripts/export-parity.js";

describe("contract parity fixture", () => {
  it("is up to date with the policy vectors (run `pnpm --filter @bursar/policy export:parity`)", () => {
    expect(readFileSync(fixturePath, "utf8")).toBe(buildParityFixture());
  });
});
