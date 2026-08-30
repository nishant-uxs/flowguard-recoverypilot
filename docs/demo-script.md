# FlowGuard RecoveryPilot — 2-Minute Judge Script

## 0:00 — Detect

Open the Control Tower and point to the `SIMULATION / DEMO MODE` badge and
`Revenue recovery opportunity detected`:

> “Payment degradation can create revenue at risk. FlowGuard detects the
> pattern before it becomes a broad incident, then quantifies whether recovery
> is worth attempting.”

Point to the affected merchant, `UPI INTENT` segment, severity and first two
pipeline stages:

> “This merchant’s UPI Intent segment is drifting above its recent baseline.
> The detector has created a structured recovery candidate.”

## 0:20 — Quantify

Point to `Expected recovery opportunity`, `Risk score`, `Amount at risk` and
`MODEL SIGNAL`:

> “The opportunity score estimates simulated value from observable signals. The
> interpretable logistic scorer supplies the estimated recovery probability.
> This seeded demo output is separate from offline calibration evidence.”

## 0:35 — Decide

Point to the horizontal pipeline and `POLICY CHECKS`:

Point to the policy checklist:

> “The model does not authorize money movement. Deterministic policy checks
> risk, value, amount, attempts, expiry, duplicates, already-paid state and
> verification.”

Point to `DECISION SOURCE: Model → Policy → Merchant approval`.

## 0:50 — Approve

Click `Approve recovery`.

> “The merchant explicitly approves one bounded payment-link attempt. Without
> this approval, the executor cannot run. It expires in 30 minutes and is
> limited to one attempt.”

## 1:05 — Execute and verify

Point to the pipeline advancing through `Approved`, `Action` and
`Verification`:

> “The default executor is deterministic simulation. This is not a live
> Razorpay payment and no production credential is involved.”

Point to `RECOVERED` and the outcome panel:

> “Creating an action is not recovery. Only the verified capture result counts,
> and the recovered amount is bounded by the candidate amount.”

## 1:25 — Measure

Point to `BATCH IMPACT`, the single chart and the separate
`DEMO / SIMULATION` runtime metric:

> “The batch view compares FlowGuard’s opportunity ranking with a fixed
> baseline. These M6 figures are synthetic evaluation results across 20
> independent seeds, not production Razorpay revenue.”

> “A fixed retry would spend a limited intervention budget without ranking
> opportunities. Recovery probability varies by timing, amount, responsiveness
> and merchant context, while approval, duplicate prevention and verification
> constrain the action.”

## 1:45 — Safety and audit

Click `Duplicate Prevention` in the scenario selector and approve once:

> “The same control path blocks the replay. `IDEMPOTENCY REPLAY` appears in the
> audit timeline, and a second executor action is not created. Policy rejection,
> abstention, expiry and verification failure are available if asked.”

Finish on the audit timeline:

> “The product story is detect, quantify, decide, approve, recover, verify and
> measure—with the LLM explaining the decision but never making it.”

## Scenario selector

- `Successful Recovery`: approval leads to simulated verified recovery.
- `Policy Rejection`: amount limit blocks the candidate before approval.
- `Duplicate Prevention`: the second deterministic submission is prevented.
- `Abstention`: low confidence stops the candidate.
- `Expired Action`: approval reaches the executor’s expired outcome.
- `Verification Failure`: approval reaches a failed verification outcome.

All scenarios reset in memory to a fixed seed. They do not require a database,
LLM credentials, Razorpay credentials or external network access beyond the
local demo API.
