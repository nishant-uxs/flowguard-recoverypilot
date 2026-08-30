# FlowGuard RecoveryPilot 2.0 — Product Specification

## User

The primary user is a merchant payment-operations or merchant-success
operator responsible for recovering revenue without creating duplicate,
unauthorized or low-value payment attempts.

## Single MVP problem

FlowGuard addresses one failure family: **gradual degradation in payment
success for one merchant payment-method segment**. The degradation is temporal:
it may be invisible in an individual payment but visible in a sequence of
attempts across a short window.

## Single MVP action

FlowGuard can create **one merchant-approved Razorpay Test Mode payment-link
recovery attempt** for an eligible pending payment. The link has a strict
expiry and idempotency key. The default executor is a deterministic simulation
until the test-mode integration is reliable enough for the demo.

The action does not auto-charge a customer, retry indefinitely or bypass
merchant approval.

## Core workflow

```text
Payment events
  -> temporal degradation detection
  -> recovery-opportunity prediction
  -> structured explanation
  -> deterministic policy decision
  -> human approval when required
  -> one bounded action
  -> outcome verification
  -> audit ledger
  -> batch evaluation
```

## M1 event model

M1 defines the smallest raw event contract needed to build temporal windows:

- `eventId`: unique event identifier for traceability.
- `merchantId`: merchant grouping key.
- `paymentId` and `attemptId`: payment and attempt correlation keys.
- `timestamp`: offset-aware ISO timestamp observed at event time.
- `paymentMethodSegment`: constrained payment method plus segment, so windows do not mix incompatible streams.
- `amount` and `currency`: observable transaction value.
- `status`: `initiated`, `pending`, `succeeded`, `failed` or `cancelled`.
- `failureCategory`: observable failure reason, required only for failed events.
- `latencyMs`: observed attempt latency when available.
- `retryCount`: retries already observed at event time.

The schema rejects unknown fields and future labels. Recovery success,
recovered value, degradation labels, future failure counts and intervention
outcomes belong to evaluation/outcome records, not raw payment events.

## AI boundary

The temporal ML model owns quantitative predictions:

- degradation probability
- intervention success probability
- expected recoverable value
- confidence and abstention

The LLM receives only structured model output and event evidence. It produces
a concise root-cause summary, rationale and optional customer-message draft.
It cannot call tools, change amounts, change thresholds or override policy.

Deterministic code owns policy, validation, limits, approvals, idempotency,
cooldowns, execution and payment-state verification.

## Success criteria

The final evaluation must compare FlowGuard with an interpretable statistical
baseline on the same temporal and shifted holdouts. It must report detection
precision/recall, false alerts, detection lead time, calibration, action
success, abstentions, policy rejections, duplicate prevention and recovered
test/simulated value versus the fixed baseline.

Monetary results are test-mode or simulated outcomes and will never be
described as production revenue.
