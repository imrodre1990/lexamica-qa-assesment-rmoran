import type {
  CaseRecord,
  Firm,
  Invitation,
  OperationResult,
  Referral,
  ReferralId,
  FirmId,
  ViewResult,
} from "./types.js";

/** Default invitation lifetime, in milliseconds. Recorded on each invitation. */
export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

let counter = 0;
const nextId = (prefix: string): string => `${prefix}_${++counter}`;

/**
 * In-memory referral service. One instance owns one set of firms, cases, and
 * referrals. There is no database, no HTTP layer, and no scheduler: time is
 * advanced explicitly via `expireCurrent`. Read methods return copies, so test
 * code cannot mutate internal state by holding a reference.
 */
export class ReferralService {
  private firms = new Map<FirmId, Firm>();
  private cases = new Map<string, CaseRecord>();
  private referrals = new Map<ReferralId, Referral>();

  constructor(private now: () => number = Date.now) {}

  // ----- setup -------------------------------------------------------------

  addFirm(firm: Firm): void {
    this.firms.set(firm.id, firm);
  }

  addCase(record: CaseRecord): void {
    this.cases.set(record.id, record);
  }

  /**
   * Create a referral and open the first invitation in the candidate order.
   * Returns the new referral id.
   */
  createReferral(input: {
    caseId: string;
    originatingFirmId: FirmId;
    candidateFirmIds: FirmId[];
  }): ReferralId {
    if (!this.cases.has(input.caseId)) {
      throw new Error(`unknown case: ${input.caseId}`);
    }
    if (input.candidateFirmIds.length === 0) {
      throw new Error("a referral needs at least one candidate firm");
    }
    const id = nextId("ref");
    const referral: Referral = {
      id,
      caseId: input.caseId,
      originatingFirmId: input.originatingFirmId,
      candidateFirmIds: [...input.candidateFirmIds],
      currentIndex: 0,
      status: "OPEN",
      heldByFirmId: null,
      claims: [],
      invitations: [],
    };
    referral.invitations.push(this.openInvitation(referral, 0));
    this.referrals.set(id, referral);
    return id;
  }

  // ----- reads -------------------------------------------------------------

  getReferral(referralId: ReferralId): Referral {
    return structuredClone(this.mustGet(referralId));
  }

  /** What `firmId` is permitted to see about `referralId` at this moment. */
  view(referralId: ReferralId, firmId: FirmId): ViewResult {
    const referral = this.mustGet(referralId);
    const caseRecord = this.cases.get(referral.caseId)!;
    const invitation = this.latestInvitationFor(referral, firmId);

    // The holder — and only the holder — sees protected detail.
    if (referral.heldByFirmId === firmId) {
      return {
        access: "FULL",
        referralId,
        status: referral.status,
        yourInvitationStatus: invitation ? invitation.status : "NONE",
        case: {
          practiceArea: caseRecord.preview.practiceArea,
          jurisdiction: caseRecord.preview.jurisdiction,
          summary: caseRecord.preview.summary,
          protected: { ...caseRecord.protected },
        },
      };
    }

    // Any firm that has been invited may see the non-confidential preview.
    if (invitation) {
      return {
        access: "PREVIEW",
        referralId,
        status: referral.status,
        yourInvitationStatus: invitation.status,
        case: {
          practiceArea: caseRecord.preview.practiceArea,
          jurisdiction: caseRecord.preview.jurisdiction,
          summary: caseRecord.preview.summary,
        },
      };
    }

    // A firm that was never invited has no access at all.
    return {
      access: "DENIED",
      referralId,
      reason: "no invitation on this referral",
    };
  }

  // ----- firm actions ------------------------------------------------------

  /** The currently invited firm accepts its open invitation. */
  accept(referralId: ReferralId, firmId: FirmId): OperationResult {
    const referral = this.mustGet(referralId);

    if (referral.status === "CONFLICT") {
      return this.reject(referral, "FROZEN");
    }
    if (referral.status === "ENGAGED") {
      return referral.heldByFirmId === firmId
        ? this.ok(referral, "ALREADY_HELD")
        : this.reject(referral, "ALREADY_ENGAGED");
    }
    if (referral.status === "EXHAUSTED") {
      return this.reject(referral, "CLOSED");
    }

    const invitation = this.latestInvitationFor(referral, firmId);
    if (!invitation) {
      return this.reject(referral, "NO_INVITATION");
    }
    if (invitation.status !== "PENDING") {
      // Their invitation already expired or was declined. An in-band accept is
      // not valid; a real-world signing must come through reportOutOfBand.
      return this.reject(referral, "INVITATION_NOT_PENDING");
    }

    invitation.status = "ACCEPTED";
    referral.status = "ENGAGED";
    referral.heldByFirmId = firmId;
    referral.claims.push({ firmId, via: "IN_BAND", at: this.now() });
    return this.ok(referral);
  }

  /** The currently invited firm declines; the referral advances to the next firm. */
  decline(referralId: ReferralId, firmId: FirmId): OperationResult {
    const referral = this.mustGet(referralId);
    if (referral.status !== "OPEN") {
      return this.reject(referral, "NOT_OPEN");
    }
    const current = this.currentInvitation(referral);
    if (!current || current.firmId !== firmId || current.status !== "PENDING") {
      return this.reject(referral, "NOT_CURRENT_INVITEE");
    }
    current.status = "DECLINED";
    this.advance(referral);
    return this.ok(referral);
  }

  /**
   * Simulate the passage of time: the current pending invitation expires and the
   * referral advances to the next firm. This is the only way time moves.
   */
  expireCurrent(referralId: ReferralId): OperationResult {
    const referral = this.mustGet(referralId);
    if (referral.status !== "OPEN") {
      return this.reject(referral, "NOT_OPEN");
    }
    const current = this.currentInvitation(referral);
    if (!current || current.status !== "PENDING") {
      return this.reject(referral, "NO_PENDING_INVITATION");
    }
    current.status = "EXPIRED";
    this.advance(referral);
    return this.ok(referral);
  }

  /**
   * A firm reports that it signed the client in the real world ("out of band").
   *
   * Granted only when the firm's invitation is the one currently open. In every
   * other case the report has diverged from platform state — the firm's window
   * had closed, or another firm already holds the client — and the referral is
   * frozen to CONFLICT for human resolution. An existing holder is never
   * overwritten. Every report is recorded as a claim.
   */
  reportOutOfBand(referralId: ReferralId, firmId: FirmId): OperationResult {
    const referral = this.mustGet(referralId);
    const invitation = this.latestInvitationFor(referral, firmId);
    if (!invitation) {
      return this.reject(referral, "NO_INVITATION");
    }

    // Already engaged.
    if (referral.status === "ENGAGED") {
      if (referral.heldByFirmId === firmId) {
        return this.ok(referral, "ALREADY_HELD");
      }
      // Another firm already holds the client and now a second firm reports a
      // signing: a double-sign. Freeze; do not change the holder.
      this.recordClaimOnce(referral, firmId);
      referral.status = "CONFLICT";
      return { outcome: { status: "CONFLICT", code: "DOUBLE_SIGN" }, referral: this.snapshot(referral) };
    }

    // Already frozen.
    if (referral.status === "CONFLICT") {
      this.recordClaimOnce(referral, firmId);
      return { outcome: { status: "CONFLICT", code: "DOUBLE_SIGN" }, referral: this.snapshot(referral) };
    }

    // Open, and this firm is the one currently invited: a normal signing.
    const current = this.currentInvitation(referral);
    if (referral.status === "OPEN" && current && current.firmId === firmId && current.status === "PENDING") {
      current.status = "ACCEPTED";
      referral.status = "ENGAGED";
      referral.heldByFirmId = firmId;
      referral.claims.push({ firmId, via: "OUT_OF_BAND", at: this.now() });
      return this.ok(referral);
    }

    // Open or exhausted, but this firm's window had already closed: divergence.
    this.recordClaimOnce(referral, firmId);
    referral.status = "CONFLICT";
    return { outcome: { status: "CONFLICT", code: "DOUBLE_SIGN" }, referral: this.snapshot(referral) };
  }

  /** A human resolves a frozen referral by assigning it to one of the claimants. */
  resolveConflict(referralId: ReferralId, firmId: FirmId): OperationResult {
    const referral = this.mustGet(referralId);
    if (referral.status !== "CONFLICT") {
      return this.reject(referral, "NOT_CONFLICT");
    }
    if (!referral.claims.some((c) => c.firmId === firmId)) {
      return this.reject(referral, "UNKNOWN_CLAIMANT");
    }
    referral.heldByFirmId = firmId;
    referral.status = "ENGAGED";
    return this.ok(referral);
  }

  // ----- internals ---------------------------------------------------------

  private openInvitation(referral: Referral, seq: number): Invitation {
    const firmId = referral.candidateFirmIds[seq];
    const at = this.now();
    return {
      id: nextId("inv"),
      referralId: referral.id,
      firmId,
      seq,
      status: "PENDING",
      createdAt: at,
      expiresAt: at + INVITE_TTL_MS,
    };
  }

  /** Move to the next candidate firm, or close the referral as exhausted. */
  private advance(referral: Referral): void {
    const next = referral.currentIndex + 1;
    if (next < referral.candidateFirmIds.length) {
      referral.currentIndex = next;
      referral.invitations.push(this.openInvitation(referral, next));
    } else {
      referral.currentIndex = -1;
      referral.status = "EXHAUSTED";
    }
  }

  private currentInvitation(referral: Referral): Invitation | undefined {
    if (referral.currentIndex < 0) return undefined;
    const firmId = referral.candidateFirmIds[referral.currentIndex];
    return [...referral.invitations].reverse().find((i) => i.firmId === firmId);
  }

  private latestInvitationFor(referral: Referral, firmId: FirmId): Invitation | undefined {
    return [...referral.invitations].reverse().find((i) => i.firmId === firmId);
  }

  private recordClaimOnce(referral: Referral, firmId: FirmId): void {
    if (!referral.claims.some((c) => c.firmId === firmId && c.via === "OUT_OF_BAND")) {
      referral.claims.push({ firmId, via: "OUT_OF_BAND", at: this.now() });
    }
  }

  private mustGet(referralId: ReferralId): Referral {
    const referral = this.referrals.get(referralId);
    if (!referral) throw new Error(`unknown referral: ${referralId}`);
    return referral;
  }

  private snapshot(referral: Referral): Referral {
    return structuredClone(referral);
  }

  private ok(referral: Referral, code?: string): OperationResult {
    return { outcome: { status: "OK", code }, referral: this.snapshot(referral) };
  }

  private reject(referral: Referral, code: string): OperationResult {
    return { outcome: { status: "REJECTED", code }, referral: this.snapshot(referral) };
  }
}
