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
| Timestamp / TTL arithmetic | The expiry clock is a constant; asserting `expiresAt === createdAt + INVITE_TTL_MS` tests the implementation, not the invariant. Worth one test in a full suite pass, not a priority now. |
| `createReferral` input validation | Edge-guard tests (unknown caseId, empty candidates). Low risk — throws immediately, easy to catch in code review. |
| Settlement and fee split | Not implemented in this module. |
| Auth / identity spoofing | Out of scope per README — firmId is passed directly; auth is a transport-layer concern. |
| Performance / load | In-memory, no I/O — irrelevant at this layer. |
| Exhaustive `seq` field checks | The sequence position is an internal detail; what matters is which firm is invited next, which the lifecycle tests cover. |

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

1. **Mutation testing.** Run a tool like Stryker to introduce deliberate bugs
   and verify the suite catches them. This turns "I have tests" into "my tests
   actually protect the invariants." Stryker works by automatically modifying
   the source code in small ways — flipping a `===` to `!==`, changing `null`
   to a value, removing a condition — then running the test suite against each
   mutation. If a test fails, the mutation is "killed" (good — the suite caught
   it). If all tests still pass, the mutation "survived" — meaning that code
   path is not actually protected, even if coverage says it is. A high mutation
   score means the tests are meaningful, not just present.
   *Priority: first — validate what we already have before adding more.*

2. **Property-based tests for the conflict path.** Use a library like
   `fast-check` to generate arbitrary interleaving sequences of accept /
   decline / reportOutOfBand calls and assert that `heldByFirmId` is always
   set at most once. This is where the subtle edge cases live.
   `fast-check` works by generating hundreds of random inputs automatically
   rather than hand-writing each scenario. You define the invariant — e.g.
   "no matter what sequence of operations runs, `heldByFirmId` is set at most
   once" — and fast-check tries to break it by exploring combinations you
   wouldn't think to write manually. When it finds a failure, it shrinks the
   input down to the smallest possible sequence that still breaks the invariant,
   making the bug easy to reproduce and fix. For the conflict path specifically,
   this catches interleaving edge cases that only appear when operations arrive
   in an unexpected order.
   *Priority: second — extends the highest-risk path with cases we can't hand-write.*

3. **AI agents embedded in the development workflow.** Three high-value agents
   for a team shipping continuously in a compliance-sensitive domain:

   - **Sprint test generation agent.** When a sprint starts in Jira and stories
     are created, an agent reads each story's acceptance criteria and automatically
     generates test case stubs scoped to the risk level of the story — conflict
     path stories get conflict-aware stubs, disclosure stories get negative test
     stubs. When a story is moved to QA status, the agent polishes the stubs into
     runnable tests using the existing patterns in the codebase, ready for a QA
     engineer to review and approve before merge. This removes the blank-page
     problem and keeps test thinking tied to feature thinking from day one.

   - **PR diff analysis agent.** When a pull request touches `referralService.ts`
     or any file in the conflict or disclosure paths, an agent analyzes the diff,
     identifies which invariants the change could affect, and comments on the PR
     with the specific test cases that should be added or updated. This acts as
     an automated code reviewer focused purely on test coverage of high-risk paths
     — catching gaps before a human reviewer has to think about them.

   - **Production audit trail agent.** When a CONFLICT event is logged in
     production, an agent reads the full audit trail — the sequence of operations,
     timestamps, and firm IDs — and automatically generates a regression test that
     reproduces the exact scenario. Real production conflicts become permanent test
     cases, so the same situation can never silently regress. This closes the loop
     between production monitoring and the test suite without requiring a human to
     manually translate an incident into a test.

   *Priority: third — scales quality across the whole team, not just the test suite.*

4. **API-layer tests.** Wrap `ReferralService` in a minimal Express router and
   add one contract test per access level to verify the HTTP boundary enforces
   the same rules as the service. This bridges the gap between the logic tests
   here and the real platform's API.
   *Priority: fourth — practical bridge to the real platform once an HTTP layer exists.*

5. **Playwright E2E smoke.** One browser test: place a referral, advance it to
   acceptance, and verify the holding firm sees the protected case detail in the
   UI while another tab (different firm) does not.
   *Priority: fifth — full-stack validation, relevant once the real platform UI exists.*

6. **Injected ID factory.** Replace the global `counter` with an injected factory
   to make ID generation deterministic and isolated per test instance.
   *Priority: sixth — small engineering fix, important for scale but not blocking.*

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
