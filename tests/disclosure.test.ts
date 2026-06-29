/**
 * disclosure.test.ts
 *
 * Guards the authorization / disclosure boundary — the second most critical
 * failure mode. Lexamica sits on confidential case data (client name, contact,
 * case facts). Leaking that data to a firm that hasn't accepted the referral
 * violates attorney-client privilege and platform ethics rules.
 *
 * These are deliberately negative tests: they assert what a firm must NOT be
 * able to see, not just what it can. A regression here means a firm can read
 * protected data it isn't entitled to — that's a compliance failure, not just
 * a UX bug.
 *
 * Access levels:
 *   FULL     — only the firm that currently holds the referral (heldByFirmId)
 *   PREVIEW  — any firm that has ever been invited (non-confidential summary only)
 *   DENIED   — a firm with no invitation history on this referral
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createSeededWorld } from "../src/index.js";
import type { SeededWorld } from "../src/seed.js";

const FIXED_NOW = 1_700_000_000_000;
const clock = () => FIXED_NOW;

// ---------------------------------------------------------------------------
// Suite 1 — Uninvited firm gets no access at all
// ---------------------------------------------------------------------------

describe("disclosure: uninvited firm is fully denied", () => {
  let world: SeededWorld;

  beforeEach(() => {
    world = createSeededWorld(clock);
  });

  it("returns DENIED for a firm with no invitation on this referral", () => {
    // Protects: a firm that was never part of this referral's candidate list
    // must receive zero information — not even the preview summary.
    const { service, referralId } = world;
    const outsider = "firm-outsider";

    const result = service.view(referralId, outsider);

    expect(result.access).toBe("DENIED");
  });

  it("does not expose any case data in a DENIED response", () => {
    // Structural check: the DENIED shape must not contain a `case` field.
    // If the field ever sneaks in, a client could extract data from the response.
    const { service, referralId } = world;

    const result = service.view(referralId, "firm-outsider");

    expect(result).not.toHaveProperty("case");
  });

  it("denies the originating firm access to protected data", () => {
    // The firm that placed the case on the platform is NOT a candidate firm.
    // It should not be able to read the protected case detail through the
    // view surface either.
    const { service, referralId, firms } = world;

    const result = service.view(referralId, firms.originating);

    // Originating firm has no invitation, so access must be DENIED.
    expect(result.access).toBe("DENIED");
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Invited-but-not-holding firm sees preview only
// ---------------------------------------------------------------------------

describe("disclosure: invited firm sees preview but not protected data", () => {
  let world: SeededWorld;

  beforeEach(() => {
    world = createSeededWorld(clock);
    // After createSeededWorld: firm-a expired, firm-b is currently invited.
  });

  it("returns PREVIEW access for the currently invited firm", () => {
    // firm-b is invited and pending — it may see the non-confidential summary
    // to decide whether to accept, but not the client's identity or facts.
    const { service, referralId, firms } = world;

    const result = service.view(referralId, firms.b);

    expect(result.access).toBe("PREVIEW");
  });

  it("does not expose protected fields in a PREVIEW response", () => {
    // The PREVIEW shape must never include clientName, clientContact, or facts.
    // This is the primary disclosure guard for pending invitations.
    const { service, referralId, firms } = world;

    const result = service.view(referralId, firms.b);

    expect(result).not.toHaveProperty("case.protected");
    if (result.access === "PREVIEW") {
      expect(result.case).not.toHaveProperty("clientName");
      expect(result.case).not.toHaveProperty("clientContact");
      expect(result.case).not.toHaveProperty("facts");
    }
  });

  it("returns PREVIEW for a firm whose invitation has already expired", () => {
    // firm-a's invitation expired, but it was invited — it should still see
    // the preview (it knows it was considered). It must not see protected data.
    const { service, referralId, firms } = world;

    const result = service.view(referralId, firms.a);

    expect(result.access).toBe("PREVIEW");
    expect(result).not.toHaveProperty("case.protected");
  });

  it("returns PREVIEW for a firm that explicitly declined", () => {
    // A firm that declined an invitation was still invited — it retains preview
    // access but must never see protected detail after declining.
    const freshWorld = createSeededWorld(clock);
    const { service, referralId, firms } = freshWorld;

    service.decline(referralId, firms.b); // firm-b declines
    const result = service.view(referralId, firms.b);

    expect(result.access).toBe("PREVIEW");
    expect(result).not.toHaveProperty("case.protected");
  });

  it("does not upgrade a pending firm to FULL before it accepts", () => {
    // A firm with a PENDING invitation must never receive FULL access —
    // only the firm that has actually accepted and holds the referral may.
    const { service, referralId, firms } = world;

    const result = service.view(referralId, firms.b);

    expect(result.access).not.toBe("FULL");
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — Only the holder gets FULL access
// ---------------------------------------------------------------------------

describe("disclosure: only the holding firm receives full case detail", () => {
  let world: SeededWorld;

  beforeEach(() => {
    world = createSeededWorld(clock);
    world.service.accept(world.referralId, world.firms.b); // firm-b now holds
  });

  it("returns FULL access for the firm that accepted the referral", () => {
    const { service, referralId, firms } = world;

    const result = service.view(referralId, firms.b);

    expect(result.access).toBe("FULL");
  });

  it("exposes protected case data only to the holder", () => {
    // Verify the protected fields are actually present for the holder and
    // contain real data — not empty strings or undefined.
    const { service, referralId, firms } = world;

    const result = service.view(referralId, firms.b);

    if (result.access === "FULL") {
      expect(result.case.protected).toBeDefined();
      expect(result.case.protected.clientName).toBeTruthy();
      expect(result.case.protected.clientContact).toBeTruthy();
      expect(result.case.protected.facts).toBeTruthy();
    }
  });

  it("still returns PREVIEW (not FULL) for a previously invited firm after another firm accepts", () => {
    // firm-a was invited (and expired) before firm-b accepted. firm-a must NOT
    // be upgraded to FULL just because it was part of the sequence.
    const { service, referralId, firms } = world;

    const result = service.view(referralId, firms.a);

    expect(result.access).toBe("PREVIEW");
    expect(result).not.toHaveProperty("case.protected");
  });

  it("still returns DENIED for an uninvited firm after the referral is ENGAGED", () => {
    // Engaging a referral must not broaden visibility to firms outside the
    // candidate list.
    const { service, referralId } = world;

    const result = service.view(referralId, "firm-outsider");

    expect(result.access).toBe("DENIED");
  });

  it("does not expose protected data to the next-in-line firm (firm-c) that was never reached", () => {
    // firm-c is in the candidate list but never received an invitation because
    // firm-b accepted first. firm-c must not see any case data.
    const { service, referralId, firms } = world;

    const result = service.view(referralId, firms.c);

    expect(result.access).toBe("DENIED");
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — Disclosure after conflict
// ---------------------------------------------------------------------------

describe("disclosure: access during and after a CONFLICT state", () => {
  it("does not grant FULL access to either claimant while frozen", () => {
    // When a referral is CONFLICT, heldByFirmId may be null or set to the
    // original holder. Either way, a firm that only has an out-of-band claim
    // must not receive FULL access.
    const { service, referralId, firms } = createSeededWorld(clock);

    service.accept(referralId, firms.b);   // firm-b holds
    service.reportOutOfBand(referralId, firms.a); // → CONFLICT

    const resultA = service.view(referralId, firms.a);
    // firm-a was invited (expired), so it sees PREVIEW — but not FULL.
    expect(resultA.access).not.toBe("FULL");
    expect(resultA).not.toHaveProperty("case.protected");
  });

  it("grants FULL access after conflict is resolved and a holder is assigned", () => {
    // Once a human resolves the conflict and assigns a holder, that firm and
    // only that firm should see FULL detail.
    const { service, referralId, firms } = createSeededWorld(clock);

    service.accept(referralId, firms.b);
    service.reportOutOfBand(referralId, firms.a); // → CONFLICT
    service.resolveConflict(referralId, firms.b); // human assigns to firm-b

    const result = service.view(referralId, firms.b);
    expect(result.access).toBe("FULL");
  });
});
