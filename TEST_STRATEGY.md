# Risk-Based Test Strategy

## Context

Lexamica is a legal referral network. It routes confidential case files between
law firms and sits on top of real money, attorney-client privilege, and bar
ethics rules. The reference implementation (`ReferralService`) is the core
invitation lifecycle — the single module where the most consequential bugs
would live.

This strategy ranks behaviors by what it would cost if they broke, decides the
right layer for each, and explicitly draws the line between blocking and
advisory checks.

---

## Risk ranking: what matters most and why

### 1. Conflict / double-sign detection — CRITICAL

**What it is:** Two firms both believe they represent the same client.

**Why it tops the list:** Duplicate representation is not a data bug — it is an
ethical violation and a potential bar complaint. A client receiving contradictory
legal advice from two firms that each think they hold the matter is a crisis that
ends client relationships and could trigger regulatory scrutiny. The platform is
the only system positioned to catch this before it reaches the real world.

The failure mode is subtle: a firm's invitation expires on the platform, the
platform moves on, but the firm signed the client offline and reports it late.
If the system does not detect this divergence and freeze the referral, two firms
can both be `ENGAGED` on the same case.

**What this test suite must prove:**
- A late out-of-band report from an expired firm triggers CONFLICT immediately.
- `heldByFirmId` is never overwritten once set — it is append-only.
- Every claim is recorded in the audit trail, even rejected ones.
- Human resolution (`resolveConflict`) is the only path out of CONFLICT.
- A frozen referral rejects all other state-changing operations.

### 2. Disclosure / authorization boundary — CRITICAL

**What it is:** Protected case data (client name, contact, facts) must only reach
the firm that currently holds the referral.

**Why it's critical:** Leaking a client's identity or case facts to an uninvited
firm violates attorney-client privilege. Even leaking to an *invited* firm before
it accepts is a confidentiality problem — the firm knows the client's name before
it has committed to representing them. The disclosure boundary is the privacy
perimeter of the entire platform.

**What this test suite must prove:**
- A firm with no invitation receives `DENIED` and no `case` field at all.
- A firm with a `PENDING`, `EXPIRED`, or `DECLINED` invitation receives `PREVIEW`
  only — no `protected` fields.
- Only `heldByFirmId` receives `FULL` access with protected detail.
- Engaging or freezing a referral does not broaden visibility to other firms.

### 3. State machine integrity — HIGH

**What it is:** The referral transitions correctly through
`OPEN → ENGAGED / EXHAUSTED / CONFLICT`, and every guard prevents illegal
transitions.

**Why it matters:** A broken transition could skip a firm in the sequence (fee
dispute), allow a firm to accept a referral it wasn't offered (fraud vector), or
leave a referral permanently stuck (operational failure). These bugs are less
catastrophic than a double-sign, but they are observable to clients and firms
and erode trust quickly.

**What this test suite must prove:**
- Decline and expiry advance to the next candidate in order.
- All candidates declining/expiring leads to `EXHAUSTED`, not a stuck state.
- A firm cannot accept out of turn (no invitation, or expired invitation).
- A second firm cannot accept after one is already `ENGAGED`.
- `getReferral` returns an immutable snapshot.

### 4. Invitation sequencing — MEDIUM

**What it is:** Invitations are created one at a time, assigned to the correct
firm at the correct sequence position, and timestamped correctly.

**Why medium, not higher:** Sequencing bugs are visible and recoverable — an ops
team can reorder or re-issue an invitation. They do not rise to the level of a
compliance event. Testing the `seq` field and `expiresAt` math is lower priority
than the above.

**What I'd defer:** Exhaustive timestamp arithmetic validation, testing every
possible field on `Invitation`, and testing that `INVITE_TTL_MS` is the exact
right duration. These belong in a later pass or exploratory session.

### 5. Out-of-scope / deliberately not tested

| Area | Reason to skip |
|------|---------------|
| Settlement and fee split | Not implemented in this module. |
| Identity / auth (firmId spoofing) | Out of scope per README — firmId is passed directly; auth is a transport-layer concern. |
| Performance / load | In-memory, no I/O — load characteristics are irrelevant here. |
| UI or API layer | No transport in this module; logic-layer tests are cheaper and more reliable. |
| `createReferral` input validation | Error paths for bad input (unknown caseId, empty candidates) are edge-guard tests. Worth one pass, not a priority. |

**What would change my mind on the deferred items:** A bug report involving fee
disputes or a compliance audit touching invitation timestamps would move
sequencing up to HIGH.

---

## Automation layer decisions

| Behavior | Layer | Reason |
|----------|-------|--------|
| Double-sign detection | Unit / service | Cheapest, most deterministic. No transport needed — the invariant lives entirely in `ReferralService`. |
| Disclosure boundary | Unit / service | Same reason. The `view()` method is the full surface to protect; testing at HTTP would add noise without adding signal. |
| State machine transitions | Unit / service | Pure logic, no I/O. Fast and precise. |
| API-layer authorization (real platform) | Integration / API | When a real HTTP layer exists, add one contract test per access level to verify the API enforces the same boundary the service does. |
| Full invitation flow (real platform) | E2E (Playwright) | One happy-path smoke test: place a referral, advance it to acceptance, verify the holding firm sees the case. Catches wiring regressions that unit tests miss. |
| Double-sign in the real platform | E2E (Playwright) | One negative E2E: expire an invitation, then POST `reportOutOfBand` — assert the API returns a CONFLICT response and the UI reflects frozen state. |

**Why not E2E for everything here:** The reference module has no HTTP layer or
UI. Adding them just to run the same logic at a higher layer would increase test
time and introduce flake without catching any additional bugs. The right test is
the cheapest one that can actually fail.

---

## What blocks a deploy vs. what is advisory

### Blocks deploy (must be green on every PR)

- All tests in `conflict.test.ts` — a double-sign regression must never ship.
- All tests in `disclosure.test.ts` — a confidentiality regression must never ship.
- All tests in `lifecycle.test.ts` — broken transitions make the product unusable.
- TypeScript typecheck (`npm run typecheck`) — type errors at this layer are bugs.

### Advisory (runs on every PR, but does not block merge)

- Exploratory / manual checks on new edge cases surfaced in code review.
- Performance benchmarks (not applicable here, but on the real platform).
- E2E suite on staging (real platform) — allowed to be slower and flakier than
  unit tests; quarantine policy described in `PIPELINE.md`.

### Never blocks (runs nightly or on demand)

- Load / soak tests.
- Security scanning (dependency audits, SAST).
- Full exploratory regression pass before a major release.
