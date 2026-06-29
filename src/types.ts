// Domain types for the referral invitation reference implementation.
// Pure data shapes — no I/O, no framework, no persistence.

export type FirmId = string;
export type ReferralId = string;
export type CaseId = string;
export type InvitationId = string;

export type ReferralStatus = "OPEN" | "ENGAGED" | "EXHAUSTED" | "CONFLICT";

export type InvitationStatus = "PENDING" | "ACCEPTED" | "DECLINED" | "EXPIRED";

export interface Firm {
  id: FirmId;
  name: string;
}

/** Non-confidential summary an invited firm may see before it accepts. */
export interface CasePreview {
  practiceArea: string;
  jurisdiction: string;
  summary: string;
}

/** Confidential case detail. Only the firm that holds the referral may see this. */
export interface CaseProtected {
  clientName: string;
  clientContact: string;
  facts: string;
}

export interface CaseRecord {
  id: CaseId;
  preview: CasePreview;
  protected: CaseProtected;
}

export interface Invitation {
  id: InvitationId;
  referralId: ReferralId;
  firmId: FirmId;
  /** Position of this firm in the candidate order (0-based). */
  seq: number;
  status: InvitationStatus;
  createdAt: number;
  expiresAt: number;
}

/** Every acceptance claim the system has observed, in order — the audit trail. */
export interface ClaimRecord {
  firmId: FirmId;
  via: "IN_BAND" | "OUT_OF_BAND";
  at: number;
}

export interface Referral {
  id: ReferralId;
  caseId: CaseId;
  originatingFirmId: FirmId;
  /** Ordered list of firms to invite, one at a time. */
  candidateFirmIds: FirmId[];
  /** Index into candidateFirmIds for the firm currently invited; -1 once closed. */
  currentIndex: number;
  status: ReferralStatus;
  /** The single firm that holds the client, if any. Set at most once. */
  heldByFirmId: FirmId | null;
  claims: ClaimRecord[];
  invitations: Invitation[];
}

/** Result returned by every state-changing operation. */
export interface OperationResult {
  outcome:
    | { status: "OK"; code?: string }
    | { status: "REJECTED"; code: string }
    | { status: "CONFLICT"; code: "DOUBLE_SIGN" };
  /** Snapshot of the referral after the operation (a copy; safe to read freely). */
  referral: Referral;
}

/** What a given firm is allowed to see about a referral right now. */
export type ViewResult =
  | {
      access: "FULL";
      referralId: ReferralId;
      status: ReferralStatus;
      yourInvitationStatus: InvitationStatus | "NONE";
      case: CasePreview & { protected: CaseProtected };
    }
  | {
      access: "PREVIEW";
      referralId: ReferralId;
      status: ReferralStatus;
      yourInvitationStatus: InvitationStatus | "NONE";
      case: CasePreview;
    }
  | {
      access: "DENIED";
      referralId: ReferralId;
      reason: string;
    };
