import { describe, it, expect } from "vitest";
import { createSeededWorld } from "../src/index.js";

// A single sanity check so `npm test` runs out of the box. It is a starting
// point, not a guide to what matters — that's yours to decide.
describe("seed", () => {
  it("loads a referral that is mid-sequence", () => {
    const { service, referralId, firms } = createSeededWorld();
    const referral = service.getReferral(referralId);

    expect(referral.status).toBe("OPEN");
    expect(referral.candidateFirmIds).toEqual([firms.a, firms.b, firms.c]);
    // firm-b is the firm currently invited.
    expect(referral.candidateFirmIds[referral.currentIndex]).toBe(firms.b);
  });
});
