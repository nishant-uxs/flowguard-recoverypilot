# Judge Questions — Honest Answers

## 1. What exactly is the AI doing?

The temporal detector estimates degradation risk from observation-time payment
signals. The opportunity scorer estimates recovery probability and expected
recovery value, then ranks candidates. The policy, approval, executor,
verification and audit layers are deterministic.

## 2. Why not just use rules?

Rules remain the safety boundary, but a fixed retry treats candidates alike.
The opportunity model uses observable differences in timing, amount, latency,
retry behavior, merchant history and responsiveness to rank a limited
intervention budget. Rules decide whether a ranked action is allowed.

## 3. Why logistic regression instead of GRU?

We tested a small GRU. Its original F1 of 1.000 hid poor useful lead time:
median lead was -15 minutes, 10-minute early attainment was 5%, and calibration
was poor (Brier 0.269, ECE 0.447). M4.5 kept the comparison honest; the simpler
logistic model had the better evidence-to-complexity tradeoff for this scope.

## 4. Why synthetic data?

No production Razorpay payment data is available in this repository. Synthetic
data lets us test temporal splits, merchant holdouts, leakage controls and
counterfactual recovery mechanics reproducibly. It cannot establish production
accuracy, revenue or generalization.

## 5. What happens with production data?

The next step is a privacy-safe, merchant-approved TEST MODE study using
observed payment outcomes. Thresholds, calibration, recovery propensity and
operational safeguards would be revalidated before any production decision.

## 6. How do you prevent duplicate payment actions?

Recovery actions use a deterministic SHA-256 key derived from merchant,
payment and action context. The service stores the action before awaiting the
executor, coalesces concurrent submissions, and reconciles an in-flight action
instead of creating another one.

## 7. Can the LLM trigger a payment?

No. The LLM receives a strict schema and returns explanation fields only. It has
no executor command, approval, policy or amount field. Unsafe, malformed,
invented or injected output falls back deterministically.

## 8. What happens if the model is wrong?

The policy can abstain or reject, and merchant approval is required before the
bounded action. A wrong opportunity score can still miss value or rank a poor
candidate; that is an accepted model limitation, not something the policy
pretends to solve.

## 9. Why is merchant approval required?

Recovery is a financial/test action with merchant context and customer impact.
The model can recommend, but a merchant must authorize the one payment-link
attempt before execution.

## 10. How do you know recovery actually happened?

Link creation is only an intervention. Recovery requires verification of paid
status and a positive `amount_paid`, bounded to the candidate amount. Pending,
failed, expired and already-recovered outcomes are never counted as recovered.

## 11. What is the baseline?

The M6 baseline selects the same candidate pool in fixed input order. It uses
the same approval, amount, timing, executor and verification constraints; it
does not receive the FlowGuard opportunity score.

## 12. How was incremental value measured?

For each of 20 independent seeds and budgets of 10, 25, 50, 75 and 100, both
strategies run against the same hidden counterfactual outcomes. Recovered
value is summed only for verified simulated outcomes. At budget 50 the means
were 150,936.9 for FlowGuard and 85,373.5 for baseline simulated units.

## 13. What are the biggest limitations?

The data, response model and demo outcomes are synthetic. The demo detector
and opportunity score are seeded structured inputs rather than a live
production stream. M6 demonstrates ranking under its response model, not
production economics or a guaranteed recovery rate.

## 14. What would you build next with real Razorpay data?

Create a privacy-safe outcome dataset, calibrate recovery probability on
observed TEST MODE results, validate merchant and segment drift, run shadow
evaluation, and measure customer/merchant impact with explicit approval and
rollback controls.

## 15. Why does this matter to Razorpay?

Payment degradation is not uniform: some merchant-segment opportunities may be
more recoverable than others. A controlled ranking layer can focus scarce
interventions while preserving merchant approval, idempotency, verification
and auditability. The value hypothesis still needs real TEST MODE evidence.
