# Referral Invitation — QA Submission

This repository is the completed QA take-home for Lexamica. It extends the
reference implementation with a focused test suite, a risk-based test strategy,
and a pipeline design note.

---

## How to run the tests

**Requirements:** Node 18 or later, npm.

```bash
# 1. Install dependencies (only needed once)
npm install

# 2. Run the full test suite
npm test

# 3. Optional: run in watch mode while editing
npm run test:watch

# 4. Optional: verify TypeScript types
npm run typecheck
```

Expected output with all tests passing:

```
 ✓ tests/smoke.test.ts          (1 test)
 ✓ tests/conflict.test.ts       (13 tests)
 ✓ tests/disclosure.test.ts     (15 tests)
 ✓ tests/lifecycle.test.ts      (16 tests)

 Test Files  4 passed (4)
      Tests  45 passed (45)
```

No network access is required. Everything runs in-memory.

---

## Repository layout

```
src/
  types.ts              Domain types (unchanged)
  referralService.ts    The lifecycle service (unchanged — system under test)
  seed.ts               createSeededWorld() factory (unchanged)
  index.ts              Exports (unchanged)

tests/
  smoke.test.ts         Original starter test (unchanged)
  conflict.test.ts      ← Double-sign / conflict path tests
  disclosure.test.ts    ← Authorization / disclosure boundary tests
  lifecycle.test.ts     ← State machine and sequence integrity tests

.github/
  workflows/
    ci.yml              GitHub Actions pipeline (illustrative; see notes below)

TEST_STRATEGY.md        Part 1 — Risk-based test strategy
PIPELINE.md             Part 3 — CI/CD and quality gate design
README.md               This file
```

---

## What I tested and why

### 1. Conflict / double-sign (`conflict.test.ts`) — CRITICAL

The single highest-risk path in this domain. A double-sign means two firms both
believe they represent the same client — that is a legal and ethical crisis
(duplicate representation), not just a data bug. The platform is the only system
positioned to catch it.

**Key invariants tested (priority order):**
- `heldByFirmId` is never set or overwritten by a late or conflicting claim — this
  is the single field that, if wrong, causes duplicate representation.
- A second firm reporting after another has already accepted triggers `CONFLICT`
  and does NOT overwrite the original holder.
- Every claim is recorded in the audit trail, even rejected ones — a human
  resolver needs the full history to make a fair decision.
- A frozen referral rejects all further state-changing operations including
  in-band accepts.
- `resolveConflict` guards: rejects non-claimants and rejects calls on
  non-frozen referrals — the resolution step must not introduce its own errors.

### 2. Disclosure / authorization (`disclosure.test.ts`) — CRITICAL

Protected case data (client name, contact, case facts) must never reach a firm
that does not hold the referral. This is an attorney-client privilege boundary.

**Key invariants tested (priority order):**
- A `DENIED` response contains no `case` field at all — structural guard that
  prevents data extraction regardless of the access level returned.
- A `PREVIEW` response never includes the `protected` sub-object — checked at
  the field level, not just the access level.
- A firm that was never reached (firm-c when firm-b accepted first) stays
  `DENIED` — being a candidate is not the same as being invited.
- A previously invited firm is not upgraded to `FULL` after another firm accepts.
- Only `heldByFirmId` receives `FULL` access with real protected data present.

### 3. Lifecycle / state machine (`lifecycle.test.ts`) — HIGH

Broken transitions could skip firms (fee dispute), allow out-of-turn accepts
(fraud vector), or leave a referral permanently stuck (operational failure).

**Key invariants tested (priority order):**
- `heldByFirmId` is set to the accepting firm — same invariant that drives all
  access control downstream in the disclosure tests.
- Idempotent accept: calling accept twice returns `ALREADY_HELD`, not an error —
  network retries in a real platform must be handled gracefully.
- Guards: expired firm rejected with `INVITATION_NOT_PENDING`, second firm
  rejected with `ALREADY_ENGAGED`, uninvited firm rejected — firms act only
  on their own turn.
- Exhausted referral rejects all accepts with `CLOSED` — the end state is final.
- `getReferral` returns a deep copy — mutating the snapshot does not affect
  internal state.

---

## What I deliberately left out

| Area | Reason |
|------|--------|
| Timestamp / TTL arithmetic | The expiry clock is a constant. Asserting `expiresAt === createdAt + INVITE_TTL_MS` tests the implementation, not the invariant. |
| `createReferral` input validation | Low risk — throws immediately on bad input, easy to catch in code review. |
| Settlement and fee split | Not implemented in this module. |
| Auth / identity spoofing | Out of scope — `firmId` is passed directly; auth is a transport-layer concern. |
| Performance / load | In-memory, no I/O — irrelevant at this layer. |
| Exhaustive `seq` field checks | Internal detail; what matters is which firm is invited next, which the lifecycle tests cover. |

---

## Assumptions I made

1. **`view()` is the sole read surface.** The assignment says "through the
   service's read surface" — I treated `view()` as the only method a firm would
   call to read case data. `getReferral()` is an internal/admin method and not
   the target of the disclosure tests, though its snapshot isolation is tested.

2. **The originating firm is not a candidate.** The seed world uses
   `firm-origin` as originating and `firm-a/b/c` as candidates. I tested that
   `firm-origin` gets `DENIED` from `view()`, treating originator-as-candidate
   as explicitly out of scope.

3. **`CONFLICT` means frozen, not resolved.** A referral in `CONFLICT` state
   rejects all operations except `resolveConflict`. I assumed no automatic
   resolution logic exists or should exist.

4. **Duplicate `reportOutOfBand` from the same firm is idempotent.** A firm
   calling `reportOutOfBand` twice should not produce two claims. The service
   implements `recordClaimOnce` for this; I verified it but did not assume
   the second call is a hard error.

5. **The global `counter` in `referralService.ts` is shared across the test
   process.** I never assert on specific ID values (e.g. `ref_1`) to avoid
   order-dependent failures. See the testability ask in `PIPELINE.md`.

---

## What I'd do with more time

1. **Mutation testing with Stryker.** Stryker automatically introduces small bugs into
   the source code — flipping a condition, removing a guard — then runs the test suite
   against each change. If a test fails, the bug was caught. If all tests still pass,
   that code path is unprotected even if coverage says otherwise. This turns "I have
   tests" into "my tests actually protect the invariants."

2. **Property-based tests on the conflict path with fast-check.** Instead of
   hand-writing specific scenarios, fast-check generates hundreds of random operation
   sequences automatically and tries to break the invariant — e.g. `heldByFirmId` set
   more than once. When it finds a failure it shrinks it to the shortest reproducible
   sequence. This catches interleaving edge cases that no hand-written test would think
   to cover.

3. **AI agents embedded in the workflow.** Three targeted agents for a compliance-sensitive
   team shipping continuously:
   - **Sprint agent** — reads Jira story acceptance criteria when a sprint starts and
     generates test case stubs; polishes them into runnable tests when the story moves
     to QA status.
   - **PR diff agent** — when a PR touches the conflict or disclosure paths, comments
     with the specific test cases that should be added or updated before merge.
   - **Production audit agent** — when a CONFLICT event is logged in production, reads
     the full audit trail and generates a regression test automatically. Real incidents
     become permanent test cases without a human having to translate them.

4. **API-layer tests.** Wrap `ReferralService` in a minimal Express router and add one
   contract test per access level — verifying the HTTP boundary enforces the same rules
   as the service. Catches wiring bugs that unit tests miss, like a middleware stripping
   a field before it reaches the service logic.

5. **Playwright E2E smoke.** One browser test covering the full acceptance flow: place
   a referral, advance it to acceptance, verify the holding firm sees protected case
   detail while a second browser tab logged in as a different firm does not. Catches
   full-stack integration issues invisible at the unit layer.

6. **Injected ID factory.** Replace the global `counter` in `referralService.ts` with
   an injected factory so each `ReferralService` instance generates its own isolated IDs.
   Currently two test files running in the same process share the counter, which makes
   tests order-dependent if they ever assert on specific ID values.

---

## CI/CD

The `.github/workflows/ci.yml` file shows the intended pipeline:

- **On every PR:** typecheck + unit tests run in parallel. Both must pass to merge.
- **On merge to main:** the same unit suite re-runs on the merge commit, then
  integration and E2E jobs would follow. Those two jobs are commented out in
  the workflow file because this module has no HTTP server or database — it is
  pure in-memory TypeScript with no transport layer to test against. On the real
  Lexamica platform (Next.js + Express + MongoDB), these jobs would spin up a
  real database, hit the real API with HTTP requests, and drive a browser via
  Playwright. The commented-out jobs show exactly what that would look like so
  the design intent is clear even though they are not runnable here.

The integration and E2E jobs are included as a design reference, not runnable
code for this module. See `PIPELINE.md` for the full quality-gate design, flake
policy, and production observability plan.

---
