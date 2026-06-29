import { ReferralService } from "./referralService.js";
import type { ReferralId } from "./types.js";

export interface SeededWorld {
  service: ReferralService;
  referralId: ReferralId;
  firms: { originating: string; a: string; b: string; c: string };
}

/**
 * Build a fresh service seeded with one referral that is already mid-sequence:
 * firm-a's invitation has expired and firm-b is currently invited (firm-c is
 * still further down the list). Call this in a fresh setup for each test so
 * cases stay isolated.
 *
 * @param now Optional clock for deterministic timestamps.
 */
export function createSeededWorld(now: () => number = Date.now): SeededWorld {
  const service = new ReferralService(now);

  const firms = { originating: "firm-origin", a: "firm-a", b: "firm-b", c: "firm-c" };
  service.addFirm({ id: firms.originating, name: "Origin & Partners" });
  service.addFirm({ id: firms.a, name: "Firm A" });
  service.addFirm({ id: firms.b, name: "Firm B" });
  service.addFirm({ id: firms.c, name: "Firm C" });

  service.addCase({
    id: "case-1",
    preview: {
      practiceArea: "Motor vehicle accident",
      jurisdiction: "AR",
      summary: "Rear-end collision, disputed liability, soft-tissue injuries.",
    },
    protected: {
      clientName: "Jane Doe",
      clientContact: "jane.doe@example.com / (501) 555-0142",
      facts: "Treating at Little Rock Ortho; prior claim in 2021; recorded statement on file.",
    },
  });

  const referralId = service.createReferral({
    caseId: "case-1",
    originatingFirmId: firms.originating,
    candidateFirmIds: [firms.a, firms.b, firms.c],
  });

  // Advance to mid-sequence: firm-a's invitation expires, firm-b is now invited.
  service.expireCurrent(referralId);

  return { service, referralId, firms };
}
