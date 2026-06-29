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

**Key invariants tested:**
- A late out-of-band report from an expired firm freezes the referral to
  `CONFLICT` and does NOT set `heldByFirmId`.
- A second firm reporting after another has already accepted also triggers
  `CONFLICT` and does NOT overwrite the original holder.
- Every claim is recorded in the audit trail, even rejected ones.
- A frozen referral rejects all further state-changing operations.
- `resolveConflict` is the only valid path out of `CONFLICT`, and only for
  firms that actually claimed the client.

### 2. Disclosure / authorization (`disclosure.test.ts`) — CRITICAL

Protected case data (client name, contact, case facts) must never reach a firm
that does not hold the referral. This is an attorney-client privilege boundary.

**Key invariants tested:**
- An uninvited firm receives `DENIED` and no `case` field.
- A firm with a `PENDING`, `EXPIRED`, or `DECLINED` invitation receives `PREVIEW`
  only — never the `protected` sub-object.
- Only `heldByFirmId` receives `FULL` access.
- Engaging or freezing a referral does not expand visibility to other firms.
- A firm that was never reached (firm-c when firm-b accepted) stays `DENIED`.

### 3. Lifecycle / state machine (`lifecycle.test.ts`) — HIGH

Broken transitions could skip firms (fee dispute), allow out-of-turn accepts
(fraud vector), or leave a referral permanently stuck (operational failure).

**Key invariants tested:**
- Accept → `ENGAGED`, correct holder set, `IN_BAND` claim recorded.
- Decline advances to the next candidate in order, keeps status `OPEN`.
- All candidates expired → `EXHAUSTED`, holder remains null.
- A firm cannot accept before it is invited, after its invitation expired, or
  after another firm is already engaged.
- `getReferral` returns a deep copy — mutating it does not affect internal state.

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
   actually protect the invariants."

2. **Property-based tests for the conflict path.** Use a library like
   `fast-check` to generate arbitrary interleaving sequences of accept /
   decline / reportOutOfBand calls and assert that `heldByFirmId` is always
   set at most once. This is where the subtle edge cases live.

3. **API-layer tests.** Wrap `ReferralService` in a minimal Express router and
   add one contract test per access level to verify the HTTP boundary enforces
   the same rules as the service. This bridges the gap between the logic tests
   here and the real platform's API.

4. **Playwright E2E smoke.** One browser test: place a referral, advance it to
   acceptance, and verify the holding firm sees the protected case detail in the
   UI while another tab (different firm) does not.

5. **Injected ID factory.** Replace the global `counter` with an injected factory
   to make ID generation deterministic and isolated per test instance.

---

## CI/CD

The `.github/workflows/ci.yml` file shows the intended pipeline:

- **On every PR:** typecheck + unit tests run in parallel. Both must pass to merge.
- **On merge to main:** same suite re-runs, then integration + E2E (commented out
  in this module since there is no HTTP/DB layer — see the inline comments for
  what these would look like on the real platform).

The integration and E2E jobs are included as an illustrative design reference,
not runnable code for this module. See `PIPELINE.md` for the full quality-gate
design, flake policy, and production observability plan.
