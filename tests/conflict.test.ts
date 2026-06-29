/**
 * conflict.test.ts
 *
 * Guards the double-sign / conflict path — the most catastrophic failure mode
 * in this domain. A double-sign means two firms both believe they represent the
 * same client. That is a legal and ethical crisis (duplicate representation),
 * not just a data bug.
 *
 * Every test here builds a deterministic world (fixed clock, fresh instance),
 * drives the system to a specific state explicitly, and then asserts on the
 * invariant that matters: heldByFirmId never changes once set, and the referral
 * is always frozen to CONFLICT when divergence is detected.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ReferralService } from "../src/referralService.js";
import { createSeededWorld } from "../src/index.js";
import type { SeededWorld } from "../src/seed.js";

// Fixed clock so timestamps are predictable and test output is stable.
const FIXED_NOW = 1_700_000_000_000;
const clock = () => FIXED_NOW;

// ---------------------------------------------------------------------------
// Suite 1 — Late out-of-band report after expiry
// ---------------------------------------------------------------------------

describe("conflict: late out-of-band report after invitation expired", () => {
  let world: SeededWorld;

  beforeEach(() => {
    // createSeededWorld leaves firm-b currently invited, firm-a already expired.
    world = createSeededWorld(clock);
  });

  it("freezes the referral to CONFLICT when an expired firm reports a real-world signing", () => {
    // Protects: firm-a's invitation expired on the platform, but firm-a signed
    // the client in the real world and reports it late. The platform has already
    // moved on to firm-b. Allowing this claim to succeed silently would cause
    // duplicate representation — a legal and ethical crisis.
    const { service, referralId, firms } = world;

    const result = service.reportOutOfBand(referralId, firms.a);

    expect(result.outcome.status).toBe("CONFLICT");
    expect(result.outcome).toMatchObject({ status: "CONFLICT", code: "DOUBLE_SIGN" });
  });

  it("does NOT assign heldByFirmId when the first claimant is an expired firm", () => {
    // Freezing is correct; silently granting ownership to the late claimant is not.
    const { service, referralId, firms } = world;

    service.reportOutOfBand(referralId, firms.a);
    const snapshot = service.getReferral(referralId);

    expect(snapshot.heldByFirmId).toBeNull();
  });

  it("records the late out-of-band claim in the audit trail", () => {
    // Every claim — even a rejected one — must be recorded so a human resolver
    // can see the full history. Silent drops would hide evidence.
    const { service, referralId, firms } = world;

    service.reportOutOfBand(referralId, firms.a);
    const snapshot = service.getReferral(referralId);

    const claim = snapshot.claims.find((c) => c.firmId === firms.a);
    expect(claim).toBeDefined();
    expect(claim?.via).toBe("OUT_OF_BAND");
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Out-of-band report after another firm already holds the client
// ---------------------------------------------------------------------------

describe("conflict: out-of-band report after another firm is already engaged", () => {
  let world: SeededWorld;

  beforeEach(() => {
    world = createSeededWorld(clock);
  });

  it("freezes to CONFLICT when a second firm reports a signing after one already accepted in-band", () => {
    // firm-b accepts normally. Later, firm-a reports it also signed the client.
    // The platform must detect this as a double-sign immediately and freeze.
    const { service, referralId, firms } = world;

    service.accept(referralId, firms.b);
    const result = service.reportOutOfBand(referralId, firms.a);

    expect(result.outcome.status).toBe("CONFLICT");
    expect(result.outcome).toMatchObject({ code: "DOUBLE_SIGN" });
  });

  it("does NOT overwrite the original holder when conflict is detected", () => {
    // The core invariant: heldByFirmId is set at most once and never changed by
    // a conflict event. Overwriting it would silently reassign the client.
    const { service, referralId, firms } = world;

    service.accept(referralId, firms.b);
    service.reportOutOfBand(referralId, firms.a);
    const snapshot = service.getReferral(referralId);

    expect(snapshot.heldByFirmId).toBe(firms.b);
  });

  it("keeps the referral in CONFLICT even if the same late firm reports again", () => {
    // Duplicate reports from the same firm must not escalate or reset state.
    const { service, referralId, firms } = world;

    service.accept(referralId, firms.b);
    service.reportOutOfBand(referralId, firms.a);
    const result2 = service.reportOutOfBand(referralId, firms.a);

    expect(result2.outcome.status).toBe("CONFLICT");
    const snapshot = service.getReferral(referralId);
    expect(snapshot.heldByFirmId).toBe(firms.b);
  });

  it("records both claimants in the audit trail for human resolution", () => {
    // A human resolver needs to see all parties. Missing a claimant from the
    // audit trail would make a fair resolution impossible.
    const { service, referralId, firms } = world;

    service.accept(referralId, firms.b);
    service.reportOutOfBand(referralId, firms.a);
    const snapshot = service.getReferral(referralId);

    const firmBClaim = snapshot.claims.find((c) => c.firmId === firms.b);
    const firmAClaim = snapshot.claims.find((c) => c.firmId === firms.a);
    expect(firmBClaim).toBeDefined();
    expect(firmAClaim).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — Additional claims on an already-frozen referral
// ---------------------------------------------------------------------------

describe("conflict: additional claims on an already-frozen referral", () => {
  let world: SeededWorld;

  beforeEach(() => {
    world = createSeededWorld(clock);
    // Pre-freeze: firm-a reports late while firm-b is currently invited.
    world.service.reportOutOfBand(world.referralId, world.firms.a);
  });

  it("keeps status CONFLICT when another firm also reports out-of-band", () => {
    // A frozen referral must stay frozen regardless of additional reports.
    // It must not loop back to OPEN or advance to ENGAGED.
    const { service, referralId, firms } = world;

    const result = service.reportOutOfBand(referralId, firms.b);

    expect(result.outcome.status).toBe("CONFLICT");
    const snapshot = service.getReferral(referralId);
    expect(snapshot.status).toBe("CONFLICT");
  });

  it("does not assign heldByFirmId while frozen", () => {
    const { service, referralId, firms } = world;

    service.reportOutOfBand(referralId, firms.b);
    const snapshot = service.getReferral(referralId);

    expect(snapshot.heldByFirmId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — Human conflict resolution
// ---------------------------------------------------------------------------

describe("conflict: resolveConflict assigns the correct holder", () => {
  let world: SeededWorld;

  beforeEach(() => {
    world = createSeededWorld(clock);
    world.service.reportOutOfBand(world.referralId, world.firms.a); // trigger CONFLICT
  });

  it("moves the referral to ENGAGED and sets heldByFirmId when a valid claimant is chosen", () => {
    // After a human picks a winner, the referral must become ENGAGED and only
    // that firm should hold the client.
    const { service, referralId, firms } = world;

    const result = service.resolveConflict(referralId, firms.a);

    expect(result.outcome.status).toBe("OK");
    expect(result.referral.status).toBe("ENGAGED");
    expect(result.referral.heldByFirmId).toBe(firms.a);
  });

  it("rejects resolution with a firm that was not a claimant", () => {
    // Assigning the referral to a firm that never claimed the client would be
    // a data-integrity error introduced at the resolution step itself.
    const { service, referralId, firms } = world;

    const result = service.resolveConflict(referralId, firms.c);

    expect(result.outcome.status).toBe("REJECTED");
    expect(result.outcome).toMatchObject({ code: "UNKNOWN_CLAIMANT" });
  });

  it("rejects resolution on a referral that is not frozen", () => {
    // resolveConflict must be a no-op unless the referral is actually in CONFLICT.
    const freshWorld = createSeededWorld(clock);
    const result = freshWorld.service.resolveConflict(freshWorld.referralId, freshWorld.firms.b);

    expect(result.outcome.status).toBe("REJECTED");
    expect(result.outcome).toMatchObject({ code: "NOT_CONFLICT" });
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — In-band accept is blocked once the referral is frozen
// ---------------------------------------------------------------------------

describe("conflict: in-band accept is blocked on a frozen referral", () => {
  it("rejects an in-band accept after the referral is frozen to CONFLICT", () => {
    // A frozen referral must reject all state-changing operations, including a
    // firm trying to accept through the normal in-band path.
    const { service, referralId, firms } = createSeededWorld(clock);

    service.reportOutOfBand(referralId, firms.a); // → CONFLICT
    const result = service.accept(referralId, firms.b);

    expect(result.outcome.status).toBe("REJECTED");
    expect(result.outcome).toMatchObject({ code: "FROZEN" });
  });
});
