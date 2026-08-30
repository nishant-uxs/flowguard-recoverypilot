# FlowGuard RecoveryPilot — 2–3 Minute Judge Script

## 0:00 — Problem

Open the Control Tower. Point to the orange expected recovery opportunity:

> “Payment degradation can create revenue at risk. FlowGuard detects the
> pattern before it becomes a broad incident, then quantifies whether recovery
> is worth attempting.”

Call out the `SIMULATION / DEMO MODE` badge and the honest AI disclosure.

## 0:20 — Detection

Point to `WHAT IS HAPPENING?`:

> “This merchant’s UPI Intent segment is drifting above its recent baseline.
> The detector has created a structured recovery candidate.”

Point to the first two pipeline steps and the risk score.

## 0:40 — Opportunity

Point to `Expected recovery opportunity`, `Risk score`, `Amount at risk` and the
reason codes:

> “The opportunity score estimates value from observable signals. This is
> predicted recovery value, not recovered money.”

Point to `MODEL SIGNAL`:

> “The interpretable logistic opportunity scorer supplies an estimated recovery
> probability and important decision-time signals. This seeded demo output is
> labeled separately from the offline calibration evidence.”

## 1:00 — Policy

Point to the policy checklist:

> “The model does not authorize money movement. Deterministic policy checks
> risk, value, amount, attempts, expiry, duplicates, already-paid state and
> verification.”

Point to `DECISION SOURCE: Model → Policy → Merchant approval`.

## 1:20 — Approval

Click `Approve recovery`.

> “The merchant explicitly approves one bounded payment-link attempt. Without
> this approval, the executor cannot run.”

The buttons disable while the API returns the new state.

## 1:40 — Recovery

Point to the pipeline advancing through `Approved`, `Action` and
`Verification`:

> “The default executor is deterministic simulation. This is not a live
> Razorpay payment and no production credential is involved.”

## 2:00 — Verification

Point to `RECOVERED` and the outcome panel:

> “Creating an action is not recovery. Only the verified capture result counts,
> and the recovered amount is bounded by the candidate amount.”

Point to `RECOVERY VERIFIED` in the audit timeline.

## 2:15 — Impact

Point to `BATCH IMPACT` and the single chart:

> “The batch view compares FlowGuard’s opportunity ranking with a fixed
> baseline. These M6 figures are synthetic evaluation results across 20
> independent seeds, not production Razorpay revenue.”

Point to the separate `DEMO / SIMULATION` runtime metric.

> “A fixed retry would spend a limited intervention budget without ranking
> opportunities. Recovery probability varies by timing, amount, responsiveness
> and merchant context, while approval, duplicate prevention and verification
> constrain the action.”

## 2:40 — Safety

Click `Policy Rejection`, then `Abstention`, or `Duplicate Prevention` in the
scenario selector:

> “The same control path can safely stop. Low confidence abstains, policy
> limits reject, duplicate requests are blocked, expiry stops an action and
> verification failure never becomes recovered value.”

Finish on the audit timeline and `How FlowGuard Works` sequence:

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
