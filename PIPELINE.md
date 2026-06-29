# Pipeline & Quality Gate Design

How this test suite fits into a team that ships fast — and how quality is
maintained as the suite grows.

---

## Where tests run and what they gate

```
┌─────────────────────────────────────────────────────────────────┐
│  PR opened / updated                                            │
│  ├── typecheck          (fast, ~5s)     → BLOCKS merge          │
│  ├── unit tests         (fast, <30s)    → BLOCKS merge          │
│  └── lint / format      (fast, ~5s)     → BLOCKS merge          │
├─────────────────────────────────────────────────────────────────┤
│  Merge to main                                                  │
│  ├── same unit suite    (re-run on merge commit)                │
│  ├── integration tests  (real DB/API, ~2–5 min)  → BLOCKS deploy│
│  └── E2E smoke          (Playwright, ~3–5 min)   → BLOCKS deploy│
├─────────────────────────────────────────────────────────────────┤
│  Pre-deploy (staging)                                           │
│  └── E2E regression     (broader, ~10–15 min)    → advisory     │
├─────────────────────────────────────────────────────────────────┤
│  Nightly                                                        │
│  ├── full E2E suite     (all browsers)            → advisory    │
│  ├── dependency audit   (npm audit)               → advisory    │
│  └── load / soak        (k6 or similar)           → advisory    │
└─────────────────────────────────────────────────────────────────┘
```

**Why this split:** Unit tests are the cheapest signal — they run in under 30
seconds and give instant feedback on the logic that matters most. Blocking a
merge on slow E2E tests trains engineers to ignore the pipeline or work around
it. E2E tests catch wiring regressions that unit tests miss, but they belong
after merge, not as a merge gate.

---

## Keeping the pipeline fast as the suite grows

**Rule: the unit suite must stay under 60 seconds on CI.** When it creeps past
that, the team notices and we either parallelize or prune.

Concrete practices:

- **No shared state between tests.** Every test calls `createSeededWorld()` or
  `new ReferralService()` directly. No global setup, no test-order dependencies.
  This is already the pattern in this codebase.

- **No real I/O in unit tests.** The reference module has none, and the real
  platform's unit layer should follow the same rule. Database calls belong in
  integration tests.

- **Parallelise by file.** Vitest runs test files in parallel by default. Keep
  tests grouped by concern (one file per domain area) so Vitest can fan them out.

- **Tag slow tests.** Any test that takes >500ms gets a `// SLOW` comment and is
  a candidate for review. On the real platform, integration and E2E tests run in
  a separate job that doesn't block the fast feedback loop.

- **Prune duplicates.** A test that asserts the same thing as another test in the
  same file is noise. More tests ≠ more confidence. Review and trim quarterly.

---

## Flake policy

The timing- and concurrency-dependent tests are where flake lives. This module
avoids both problems by design (explicit clock, no real timers, no network), but
the real platform will have them.

**How to keep tests reliable:**

- **Deterministic time.** Pass a `now` function to `ReferralService` in every
  test. Never rely on `Date.now()` in a test — it makes assertions on timestamps
  non-deterministic and causes intermittent failures in CI when jobs are slow.

- **Deterministic IDs.** The global `counter` in `referralService.ts` is shared
  across all tests in a process. Tests that assert on specific IDs (e.g. `ref_1`)
  are order-dependent and will break when tests are added or reordered. Assert on
  shape and content, not on generated ID values.

- **One world per test.** Never share a `ReferralService` instance across tests.
  `beforeEach` creates a fresh instance every time. A test that mutates shared
  state poisons every test that runs after it.

**When a test flakes in CI:**

1. **First flake:** investigate immediately — do not retry and ignore.
2. **Reproduced locally:** fix the root cause (timing, shared state, external dep).
3. **Cannot reproduce:** add a `// FLAKE WATCH` comment, quarantine into a
   separate job for one week, monitor. If it flakes again, fix it. If it doesn't,
   restore it.
4. **Policy:** retries (`--retry=2`) are allowed on E2E tests only, never on unit
   or integration tests. A unit test that needs a retry is broken, not flaky.
5. **Never merge a flaky test.** A test that sometimes passes gives you false
   confidence and trains the team to distrust the suite.

---

## Confidence signals: how do we know a deploy is safe?

**Before deploy:**
- All PR checks green (typecheck, unit tests, lint).
- Integration test suite green on the merge commit.
- E2E smoke green on staging.
- No open P0/P1 bugs tagged `blocks-deploy` in the issue tracker.

**After deploy:**
- Error rate stable in Sentry (no spike in `ReferralService`-related errors).
- No `CONFLICT` events in Datadog that weren't present before the deploy
  (unexpected conflicts suggest a state-machine regression).
- P99 latency on `/referrals` endpoints stable in Datadog.
- On-call has not been paged within 30 minutes of deploy.

**How I know the quality gate itself is working:**

- Mutation testing run quarterly: introduce a deliberate bug (e.g. comment out
  the `CONFLICT` freeze logic) and verify at least one test fails. If no test
  catches it, the suite has a gap.
- Track "tests added per feature" over time. A team shipping features with zero
  new tests is a leading indicator of coverage decay.
- Review flake rate monthly. A rising flake rate means tests are degrading in
  reliability, not just the product.

---

## Production as part of QA

What to watch in production so the invitation flow can be monitored in real time:

**Sentry (error tracking):**
- Alert on any unhandled exception in the referral service.
- Alert on `CONFLICT` outcomes that were not followed by a `resolveConflict`
  within 24 hours — a frozen referral left unresolved is an operational failure.
- Alert on `reportOutOfBand` calls where `outcome.status === "CONFLICT"` —
  every double-sign should page someone immediately.

**Datadog (metrics and alerting):**
- Counter: `referral.outcome.conflict` — spike means a regression in conflict
  detection or a surge in real-world double-sign events.
- Counter: `referral.outcome.rejected` by `code` — a spike in `INVITATION_NOT_PENDING`
  suggests firms are trying to accept expired invitations at an unusual rate.
- Counter: `referral.view.access_denied` — unexpected spike could indicate a
  permission regression or an attempt to enumerate referrals.
- Gauge: `referral.open.age_hours` — referrals that stay OPEN unusually long
  may indicate an invitation expiry job is broken (on the real platform).

**Structured log events to instrument:**
```
referral.created         { referralId, originatingFirmId, candidateCount }
referral.invited         { referralId, firmId, seq, expiresAt }
referral.accepted        { referralId, firmId, via }
referral.conflict        { referralId, claimants: FirmId[] }
referral.resolved        { referralId, assignedTo: FirmId }
referral.exhausted       { referralId }
referral.view.denied     { referralId, requestingFirmId }
```

Every event should carry a `referralId` and a timestamp so incidents can be
reconstructed from logs alone.

---

## Testability asks for the dev team

QA as an owner means shaping how features are built, not just testing them after.
These are the changes I'd ask for before the team starts shipping daily against
this module:

1. **Inject the clock everywhere, not just in tests.** `ReferralService` already
   accepts a `now` function — good. Make sure any scheduler or background job on
   the real platform does the same so time can be controlled in integration tests.

2. **Expose a structured event log.** The `claims` array is a good start. A
   first-class event log (e.g. `events: DomainEvent[]` on `Referral`) makes it
   much easier to assert on *what happened* rather than *what the final state is*.
   It also makes the audit trail queryable in production.

3. **Make IDs deterministic in tests.** The global `counter` in
   `referralService.ts` is a shared singleton. Two test files running in the
   same process will produce overlapping IDs. Replace it with an injected ID
   factory (e.g. `idFactory: () => string`) so tests can pass a counter that
   resets per instance.

4. **Add a `reason` field to `OperationResult`.** The `code` field on `REJECTED`
   is good, but a human-readable `reason` string would make alert messages and
   customer-support tools more actionable without needing a code lookup table.

5. **Structured events over side-effects.** On the real platform, avoid writing
   notification logic (emails, webhooks) directly inside service methods. Emit an
   event; let a handler send the notification. This makes it trivial to test the
   notification logic in isolation and prevents integration tests from sending
   real emails.
