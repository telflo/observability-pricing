/**
 * The contract checks, run on every platform in the registry. A platform is
 * checked because it is in index.ts, so none can skip them, and a platform's
 * own test file holds only its worked examples.
 */
import { expect, it } from "vitest";
import { describeAdapterContract } from "./adapter-contract";
import { VENDORS } from "./index";

it("has platforms to check, each under its own id", () => {
  expect(VENDORS.length).toBeGreaterThan(0);
  const ids = VENDORS.map((v) => v.id);
  expect(new Set(ids).size).toBe(ids.length);
});

for (const vendor of VENDORS) describeAdapterContract(vendor);
