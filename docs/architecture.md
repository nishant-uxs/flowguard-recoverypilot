# FlowGuard RecoveryPilot 2.0 — Architecture

## M0 stack

- TypeScript across the application
- npm workspaces for separated API and web applications
- Fastify for the API
- React and Vite for the web application
- Zod for runtime environment and domain validation
- Vitest for tests
- ESLint and Prettier for quality gates

## Planned boundaries

```text
apps/web
  -> apps/api
       -> domain
       -> detection and inference
       -> explanation adapter
       -> policy engine
       -> recovery executor
       -> verification
       -> audit and evaluation
```

The M0 API exposes only a health endpoint. No ML, LLM, Razorpay or financial
action code exists at this milestone.

## M1 domain boundary

`packages/domain` owns the runtime-validated raw event contract. It currently
contains only:

- `PaymentEvent`: one observed payment-attempt event.
- `MerchantContext`: the merchant identifier used to group temporal streams.
- `PaymentMethodSegment`: a constrained method/segment pair.

The event schema is intentionally observation-time only. It includes timestamp,
payment outcome, value and retry/latency context, but excludes recovery success,
recovered value, future failure counts and degradation labels. Those are
derived or outcome data and would leak future information into detection.

Validation is strict: identifiers, timestamps, currency, status, method/segment,
amount and retry count are checked at the boundary. A failed event must carry an
observable failure category; non-failed events must not carry one.

## Runtime decision boundary

The final runtime will use this one-way control flow:

```text
model prediction
  -> structured recommendation
  -> deterministic policy validation
  -> approval or abstention
  -> idempotent executor
  -> verifier
```

The model and LLM will not have unrestricted access to financial tools.
The executor will be selected through an interface with simulation and
Razorpay Test Mode implementations.

## Reliability principles

- Every action has an idempotency key.
- The policy engine enforces amount, confidence, cooldown and retry limits.
- API timeouts become pending outcomes, not assumed successes.
- Duplicate requests are rejected deterministically.
- Every state transition is recorded in the audit ledger.
- The evaluation command is replayable from a fixed seed and versioned data.

## M2 temporal data boundary

`evaluation/generator/temporal-dataset.ts` produces observable
`PaymentEvent[]` data from latent merchant/segment state. The latent state
drives correlated changes in failure rate, latency and volume over five-minute
windows, but is kept in a separate truth artifact.

The default target is the UPI Intent segment. Other segments are generated with
their own heterogeneous baselines and act as controls; they do not receive the
target degradation scenario. Degraded merchants vary in start time, duration,
noise and natural recovery.

The raw export, hidden truth and temporal split manifest are separate files.
This prevents future degradation labels and outcomes from entering the event
contract. The generator uses a fixed seed, random non-semantic IDs and
merchant-aware profile assignment so repeated runs are identical without
encoding the label in an identifier.

## M3 baseline boundary

The baseline is intentionally interpretable. It calibrates each merchant from
the first 12 target-segment windows, transforms rolling failure-rate and
latency deviations into a positive EWMA score, and accumulates signed
deviations with one-sided CUSUM. Persistence, reset and cooldown logic emit
one episode-level alert instead of one alert per noisy window.

The detector receives only chronologically available observations. Truth
intervals are used by the evaluation layer only, never by the detector. The
naive comparator is a global rolling failure-rate threshold. Both use the same
episode-level evaluation protocol and untouched test period.

## M4 ML experiment boundary

The ML experiment is isolated under `evaluation/ml`. It consumes four
five-minute feature windows and predicts degradation onset during the next
30 minutes. Feature construction is past-only and excludes merchant IDs,
scenario labels and future aggregates. The training split excludes the
merchant holdout; validation selects probability thresholds and test is read
only after the operating point is frozen.

The first model is class-weighted logistic regression over flattened temporal
features. A single small GRU is evaluated separately as a sequence model. The
GRU is an offline experiment, not a runtime dependency or a recovery policy.
The local run used CPU because the installed PyTorch build exposed no CUDA
device. No model is allowed to trigger payments, call an LLM or bypass the
future recovery approval boundary.

## M4.5 evaluation boundary

M4.5 preserves the v1 generator and results and adds an independent v2
protocol under `evaluation/generalization`. Its observable events contain no
scenario labels or future outcomes. Known merchants use A/B/C degradation
families; a merchant-disjoint holdout contains shifted mechanisms D/J and
stress/confounder cases. Merchant IDs and scenario metadata are truth/audit
data, never model features.

The hardening evaluator gives every model the same episode matcher,
30-minute prediction horizon, 30-minute useful intervention window,
cooldown/debounce rule and lead-time metrics. It reports early, late-useful,
late-useless and false alerts separately. Normalized utility is parameterized
and sensitivity-tested; it is not a revenue estimate. Platt calibration and
model operating thresholds are fitted on known validation predictions only.
The v2 audit checks duplicate identifiers, merchant/scenario overlap and
simple artifact probes.

This boundary remains offline. It can inform whether a bounded demo recovery
layer is worth building, but M4.5 does not authorize production claims,
payment execution, an LLM, or dashboard integration. The first GRU's perfect
v1 F1 is explicitly treated as an evaluation warning rather than a product
decision.

## M5 recovery boundary

The bounded recovery workflow lives behind `@flowguard/recovery`:

```text
RecoveryCandidate
  -> RecoveryRecommendation
  -> deterministic policy
  -> merchant approval
  -> RecoveryExecutor
  -> verification
  -> RecoveryOutcome + audit events
```

The quantitative model supplies a score and reasons only. Policy enforces
minimum confidence, expected value, amount limit, one attempt and 30-minute
expiry. Approval is explicit; rejection, abstention, duplicate prevention,
expiry and verification timeout are terminally auditable outcomes.

`SimulationRecoveryExecutor` is the deterministic default for the demo.
`RazorpayTestRecoveryExecutor` is isolated behind the same interface and
requires an `rzp_test_` key. It creates a Payment Link through
`POST /v1/payment_links` and verifies it through the Payment Link fetch
endpoint; only a paid link's verified `amount_paid` counts. The adapter does
not claim that link creation is recovery and was not called by the batch.
The implementation follows Razorpay's documented [Payment Links API](https://razorpay.com/docs/api/payments/payment-links/)
and [Payment Link webhook events](https://razorpay.com/docs/webhooks/payment-links/);
real credentials and merchant approval are required for a live TEST MODE run.

The application-facing audit ledger is append-only from the service API and
records candidate, recommendation, policy, approval, action, verification,
outcome and duplicate events, including source event ID, payment, merchant,
model version, score and idempotency key. The batch comparison is explicitly
simulated; no production payment operation is enabled by M5.
