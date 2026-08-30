# M9 Hostile Judge Audit + M10 Submission Polish

## 1. Executive verdict

**READY for the buildathon demo, with explicit evidence boundaries.**

The product is ready to demonstrate a controlled recovery workflow over
deterministic simulation. It is not ready to claim production recovery,
production accuracy, production revenue or autonomous financial execution.

## 2. What is genuinely strong

- The quantitative evaluation, recovery service and orchestration layers are
  separate.
- The model signal is visible without giving the model authorization power.
- Deterministic policy, merchant approval, one-attempt limits, expiry,
  idempotency and verification gate execution.
- Payment-link creation is explicitly an intervention, not recovery.
- Only verified paid status and bounded `amount_paid` produce recovered value.
- M6 compares the same candidate pool and outcome environment at five budgets
  across 20 independent seeds.
- The LLM has a strict explanation-only contract and deterministic fallback.
- Runtime orchestration and recovery-service events are both exposed in the
  audit view.

## 3. What remains weak

- The demo detector and opportunity score are seeded structured inputs, not a
  live payment stream.
- The synthetic response model is authored for evaluation and is not learned
  from Razorpay outcomes.
- The demo has one candidate at a time; runtime batch counters are illustrative
  demo counters, not a live merchant portfolio.
- M4.5 evidence is synthetic and does not establish broad merchant
  generalization or production accuracy.
- The local Razorpay adapter is TEST MODE only and was not used by the default
  demo.

These limitations are now stated in the UI, pitch, judge answers, demo script
and evaluation documentation.

## 4. Synthetic-data limitations

M4.5 and M6 use reproducible synthetic generators. M6 creates hidden
counterfactual recovery outcomes from latent merchant history, customer
responsiveness, severity, time since detection, amount, retries, latency and
noise. The scorer receives only noisy decision-time proxies. Hidden outcomes,
latent propensity, future aggregates and identifiers are excluded from model
features.

The evaluation claim is limited to this environment: across 20 independent
seeds and budgets of 10, 25, 50, 75 and 100, FlowGuard beat the fixed baseline
under the synthetic response model.

## 5. ML limitations

FlowGuard’s ML contribution is:

- degradation-risk estimation from temporal payment signals
- recovery-probability estimation
- expected recovery-value ranking

M4.5 tested a small GRU and rejected product integration because the original
GRU’s perfect F1 masked poor useful lead time and calibration: median lead
`-15` minutes, 5% 10-minute early attainment, Brier `0.269`, ECE `0.447`.
The simpler logistic model provided the better evidence-to-complexity tradeoff.

The model is not an authorization system. Policy owns the action boundary.

## 6. Recovery limitations

The strict semantic sequence is:

```text
INTERVENTION → PAYMENT ATTEMPT → VERIFICATION → RECOVERED VALUE
```

The system does not count link creation as recovery. `RECOVERED` requires
verified paid status and a positive, candidate-bounded amount. Failed, pending,
expired, already-recovered and rejected outcomes do not contribute recovered
value.

## 7. Security findings

- No hardcoded live keys, private-key blocks, credential assignments or
  production endpoints were found by the repository credential-pattern scan.
- Razorpay execution requires an `rzp_test_` key.
- Simulation is the default.
- Secrets are not part of the LLM schema or explanation prompt.
- Sensitive raw customer metadata is excluded from the explanation input.
- Audit events use opaque references and do not log credentials.

## 8. Safety findings

Covered and tested:

- low confidence abstention
- low expected value abstention
- amount-limit rejection
- merchant rejection or missing approval
- already-paid stop
- duplicate prevention
- expiry
- executor failure
- verification timeout
- malformed or unavailable LLM output
- prompt-injection and policy-override text
- crash/retry reconciliation
- concurrent identical submissions

The concurrent submission hardening coalesces identical in-flight idempotency
keys, so only one executor action is created.

## 9. Demo risks

- A judge could mistake synthetic units for rupees; the UI now calls them
  simulated units and marks every evaluation/runtime area separately.
- A judge could mistake the seeded model signal for a live prediction; the UI
  labels it as seeded demo output and points to M6 calibration evidence.
- The fixed demo clock is deterministic by design; it represents actual
  emitted application events under a controlled demo clock.
- A successful simulation must not be described as live Razorpay revenue.

## 10. Judge objections

Concise answers are in [judge-questions.md](judge-questions.md). The primary
objections are:

- “This is just rules”: model scoring/ranking is separate from deterministic
  safety enforcement.
- “Why retry?”: fixed retry spends scarce budget without opportunity ranking.
- “Fake revenue”: all demo values are simulation; M6 is synthetic evidence.
- “LLM can approve”: the LLM has no action or authorization fields.
- “A link means recovery”: verification explicitly disproves that assumption.

## 11. Fixes applied

- Added a visible `MODEL SIGNAL` section with model type, estimated probability,
  signals, version and provenance; it does not mislabel the seeded fixture as a
  live calibrated prediction.
- Added a concise `WHY NOT JUST RETRY?` explanation tied to budget, timing,
  opportunity value, approval, duplicate prevention and verification.
- Removed currency-symbol ambiguity from simulated UI values; values are now
  labeled simulated units.
- Added semantic landmark heading identifiers for accessibility.
- Added concurrent idempotency coalescing and a real concurrency test.
- Added [judge questions](judge-questions.md), the
  [30-second pitch](30-second-pitch.md), and this audit.
- Updated the judge script to show model signal before policy.
- Reworked the Control Tower around a compact fintech design system, a
  horizontal recovery pipeline, restrained state transitions and reduced-motion
  support.
- Validated external Razorpay response shapes and return a clear `400` for
  malformed demo scenario requests.

## 12. Remaining accepted limitations

No production data, credentials, shadow traffic, real merchant approval or
live TEST MODE run is included. No claim is made about production accuracy,
generalization, recovered revenue or customer outcomes.

The default demo is intentionally a presentation fixture over the
orchestrator. Production use would require an outcome-backed calibration
study, shadow evaluation, operational controls and explicit TEST MODE
validation.

## 13. Final buildathon claims we can safely make

- FlowGuard demonstrates a structured path from degradation detection to
  verified simulated recovery.
- The model estimates opportunity; deterministic controls authorize and bound
  actions.
- Under the M6 synthetic response model, FlowGuard beat the fixed baseline
  across 20 seeds and tested budgets.
- The system prevents duplicate actions, requires merchant approval and does
  not count unverified actions as recovery.
- The demo works without external LLM, Razorpay or production credentials.

## 14. Claims we must not make

- FlowGuard recovers or increases production Razorpay revenue.
- The model has production accuracy or guaranteed recovery.
- The LLM autonomously approves, creates or executes payments.
- A payment-link creation is a recovered payment.
- M6 proves broad merchant generalization.
- Synthetic probabilities are calibrated production probabilities.
- The demo represents live Razorpay traffic.
