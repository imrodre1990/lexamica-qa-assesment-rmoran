/**
 * lifecycle.test.ts
 *
 * Guards the referral state machine — the sequence of valid transitions and
 * the guards that prevent illegal ones. These tests sit one level below the
 * catastrophic paths (conflict, disclosure) but are still high-value: a broken
 * transition could leave a referral stuck, skip firms, or allow a firm to
 * accept a referral it was never offered.
 *
 * Coverage here focuses on:
 *   - Happy path: full sequence from OPEN → ENGAGED
 *   - Exhaustion: all firms decline/expire → EXHAUSTED
 *   - Sequence integrity: firms are invited one at a time, in order
 *   - Guard rails: operations rejected on wrong status or wrong firm
 *   - Idempotence: repeating a valid operation is safe
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ReferralService } from "../src/referralService.js";
import { createSeededWorld } from "../src/index.js";
import type { SeededWorld } from "../src/seed.js";

const FIXED_NOW = 1_700_000_000_000;
const clock = () => FIXED_NOW;

// ---------------------------------------------------------------------------
// Suite 1 — Happy path: accept mid-sequence
// ---------------------------------------------------------------------------

describe("lifecycle: happy path accept", () => {
  let world: SeededWorld;

  beforeEach(() => {
    world = createSeededWorld(clock);
    // State on entry: firm-a expired, firm-b currently invited (PENDING).
  });

  it("sets heldByFirmId to the accepting firm", () => {
    // THE invariant for acceptance: heldByFirmId must point to exactly the
    // firm that accepted. This field drives all subsequent access control.
    const { service, referralId, firms } = world;

    service.accept(referralId, firms.b);
    const snapshot = service.getReferral(referralId);

    expect(snapshot.heldByFirmId).toBe(firms.b);
  });

  it("returns ALREADY_HELD when the same firm calls accept again", () => {
    // Idempotent: a firm that already holds the referral calling accept again
    // must be handled gracefully — not throw, not create a second claim.
    const { service, referralId, firms } = world;

    service.accept(referralId, firms.b);
    const result = service.accept(referralId, firms.b);

    expect(result.outcome.status).toBe("OK");
    expect(result.outcome).toMatchObject({ code: "ALREADY_HELD" });
  });

  it("moves the referral to ENGAGED when the current invitee accepts", () => {
    const { service, referralId, firms } = world;

    const result = service.accept(referralId, firms.b);

    expect(result.outcome.status).toBe("OK");
    expect(result.referral.status).toBe("ENGAGED");
  });

  it("records an IN_BAND claim when the firm accepts normally", () => {
    const { service, referralId, firms } = world;

    service.accept(referralId, firms.b);
    const snapshot = service.getReferral(referralId);

    const claim = snapshot.claims.find((c) => c.firmId === firms.b);
    expect(claim).toBeDefined();
    expect(claim?.via).toBe("IN_BAND");
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Decline advances to the next firm
// ---------------------------------------------------------------------------

describe("lifecycle: decline advances the sequence", () => {
  let world: SeededWorld;

  beforeEach(() => {
    world = createSeededWorld(clock);
  });

  it("rejects a decline from a firm that is not the current invitee", () => {
    // firm-a already expired — it cannot decline again on firm-b's turn.
    // Only the currently active invitee may decline. Anything else is an
    // illegal operation that must be rejected explicitly.
    const { service, referralId, firms } = world;

    const result = service.decline(referralId, firms.a);

    expect(result.outcome.status).toBe("REJECTED");
    expect(result.outcome).toMatchObject({ code: "NOT_CURRENT_INVITEE" });
  });

  it("advances to firm-c when firm-b declines", () => {
    const { service, referralId, firms } = world;

    service.decline(referralId, firms.b);
    const snapshot = service.getReferral(referralId);

    expect(snapshot.candidateFirmIds[snapshot.currentIndex]).toBe(firms.c);
  });

  it("marks firm-b's invitation as DECLINED", () => {
    const { service, referralId, firms } = world;

    service.decline(referralId, firms.b);
    const snapshot = service.getReferral(referralId);

    const inv = snapshot.invitations.find((i) => i.firmId === firms.b);
    expect(inv?.status).toBe("DECLINED");
  });

  it("keeps the referral OPEN after a decline with candidates remaining", () => {
    const { service, referralId, firms } = world;

    service.decline(referralId, firms.b);
    const snapshot = service.getReferral(referralId);

    expect(snapshot.status).toBe("OPEN");
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — Expiry advances the sequence
// ---------------------------------------------------------------------------

describe("lifecycle: expireCurrent advances the sequence", () => {
  it("rejects expiry when the referral is not OPEN", () => {
    // expireCurrent must be a no-op on any status other than OPEN. Expiring an
    // already-ENGAGED referral would be a state corruption.
    const { service, referralId, firms } = createSeededWorld(clock);

    service.accept(referralId, firms.b); // → ENGAGED
    const result = service.expireCurrent(referralId);

    expect(result.outcome.status).toBe("REJECTED");
    expect(result.outcome).toMatchObject({ code: "NOT_OPEN" });
  });

  it("advances to the next firm after expiry", () => {
    // createSeededWorld already calls expireCurrent once (firm-a → firm-b).
    // Expire firm-b to confirm it advances to firm-c.
    const { service, referralId, firms } = createSeededWorld(clock);

    service.expireCurrent(referralId);
    const snapshot = service.getReferral(referralId);

    expect(snapshot.candidateFirmIds[snapshot.currentIndex]).toBe(firms.c);
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — Exhaustion: all firms pass
// ---------------------------------------------------------------------------

describe("lifecycle: exhaustion when all firms decline or expire", () => {
  it("rejects an accept on an exhausted referral", () => {
    // Once exhausted, the referral is closed. No firm can accept it — not even
    // one that was previously invited. CLOSED is the guard code for this.
    const service = new ReferralService(clock);
    service.addFirm({ id: "f1", name: "Firm 1" });
    service.addCase({
      id: "c1",
      preview: { practiceArea: "PI", jurisdiction: "TX", summary: "Test." },
      protected: { clientName: "John", clientContact: "john@x.com", facts: "Facts." },
    });

    const referralId = service.createReferral({
      caseId: "c1",
      originatingFirmId: "f1",
      candidateFirmIds: ["f1"],
    });

    service.expireCurrent(referralId); // only candidate → EXHAUSTED
    const result = service.accept(referralId, "f1");

    expect(result.outcome.status).toBe("REJECTED");
    expect(result.outcome).toMatchObject({ code: "CLOSED" });
  });

  it("moves the referral to EXHAUSTED after all candidates are skipped", () => {
    const service = new ReferralService(clock);
    service.addFirm({ id: "f1", name: "Firm 1" });
    service.addFirm({ id: "f2", name: "Firm 2" });
    service.addCase({
      id: "c1",
      preview: { practiceArea: "PI", jurisdiction: "TX", summary: "Test case." },
      protected: { clientName: "John", clientContact: "john@x.com", facts: "Facts." },
    });

    const referralId = service.createReferral({
      caseId: "c1",
      originatingFirmId: "f1",
      candidateFirmIds: ["f1", "f2"],
    });

    service.expireCurrent(referralId); // f1 expires → f2 invited
    service.expireCurrent(referralId); // f2 expires → exhausted

    const snapshot = service.getReferral(referralId);
    expect(snapshot.status).toBe("EXHAUSTED");
    expect(snapshot.heldByFirmId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — A non-current firm cannot accept or decline out of turn
// ---------------------------------------------------------------------------

describe("lifecycle: sequence integrity — firms act only on their own turn", () => {
  let world: SeededWorld;

  beforeEach(() => {
    world = createSeededWorld(clock);
    // firm-b is currently invited.
  });

  it("rejects an in-band accept from firm-a whose invitation already expired", () => {
    // An expired invitation is not a valid basis for an in-band accept.
    // Real-world signings from an expired firm must go through reportOutOfBand.
    // This is what separates an honest late report from an unauthorized accept.
    const { service, referralId, firms } = world;

    const result = service.accept(referralId, firms.a);

    expect(result.outcome.status).toBe("REJECTED");
    expect(result.outcome).toMatchObject({ code: "INVITATION_NOT_PENDING" });
  });

  it("rejects a second firm's accept after the referral is already ENGAGED", () => {
    // Once one firm holds the referral, no other firm can accept. This is the
    // in-band equivalent of the conflict guard.
    const { service, referralId, firms } = world;

    service.accept(referralId, firms.b); // → ENGAGED
    const result = service.accept(referralId, firms.c);

    expect(result.outcome.status).toBe("REJECTED");
    expect(result.outcome).toMatchObject({ code: "ALREADY_ENGAGED" });
  });

  it("rejects an in-band accept from firm-c before it has been invited", () => {
    // firm-c is next in line but has not yet received an invitation.
    // It must not be able to jump the queue.
    const { service, referralId, firms } = world;

    const result = service.accept(referralId, firms.c);

    expect(result.outcome.status).toBe("REJECTED");
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — getReferral returns a copy, not a live reference
// ---------------------------------------------------------------------------

describe("lifecycle: getReferral snapshot isolation", () => {
  it("does not reflect mutations made to the returned snapshot", () => {
    // If getReferral returned a live reference, test (or production) code could
    // accidentally mutate internal state. It must return a deep copy — this is
    // a testability and safety requirement, not just a nice-to-have.
    const { service, referralId } = createSeededWorld(clock);

    const snapshot = service.getReferral(referralId);
    snapshot.status = "EXHAUSTED"; // mutate the copy

    const fresh = service.getReferral(referralId);
    expect(fresh.status).toBe("OPEN"); // internal state unchanged
  });
});
