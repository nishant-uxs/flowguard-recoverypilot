# FlowGuard Agent Architecture — M7

## Boundary

FlowGuard is deliberately not an autonomous tool-calling agent. The
quantitative core owns detection and opportunity scoring; deterministic code
owns authorization and financial/test actions. The LLM is an explanation and
message-drafting component only.

```text
observed events
      |
      v
temporal degradation detector
      |
      v
recovery opportunity scorer
      |
      v
RecoveryOrchestrator
      |
      +--> structured candidate + recommendation
      |          |
      |          v
      |     deterministic policy
      |          |
      |     reject/abstain ------> audit + deterministic explanation
      |          |
      |          v
      |     merchant approval
      |          |
      |     reject --------------> audit + stop
      |          |
      |          v
      |     bounded RecoveryExecutor
      |          |
      |     Simulation or Razorpay TEST MODE
      |          |
      |          v
      |     verification
      |          |
      |          v
      |     outcome + recovered value + audit
      |
      +--> LLM explanation provider
             |
             +--> validated explanation
             +--> deterministic fallback on any failure
```

The deterministic policy preserves minimum risk and expected value thresholds,
amount and attempt limits, 30-minute action expiry, merchant approval,
duplicate prevention, already-recovered checks, a merchant cooldown and
verification gating. These values are not writable through the LLM contract.

The `RecoveryApprovalPayload` is the human-approval UX contract. It contains
opaque references, reason codes, risk score, expected value, amount, action
type, expiry, named policy-check results and the validated explanation. It has
no executor command or implicit approval field; approval is a separate
deterministic input.

The LLM receives a strict, minimal input containing opaque merchant/payment
references, scores, normalized signal codes, amount, policy decision and
verified outcome. Customer PII, secrets, credentials, raw metadata and future
outcomes are excluded. Payment metadata and signal text are treated as
untrusted data; only allow-listed signal codes reach the provider.

The structured LLM response contains summary, reason codes, merchant
explanation and an optional customer-message draft. It has no action,
authorization, policy, amount-limit or executor fields. Output validation
rejects malformed, invented reason codes, unverified recovery claims,
secret requests, commands and policy-override language. A provider timeout,
rate limit, malformed response or unsafe response falls back to a
deterministic explanation without affecting the recovery state.

## State machine

```text
DETECTED -> SCORED -> POLICY_APPROVED -> AWAITING_MERCHANT_APPROVAL -> APPROVED
                                                        |                 |
                                                        v                 v
                                                   REJECTED/ABSTAINED  EXECUTING
                                                                          |
                                                                          v
                                                               PENDING_VERIFICATION
                                                                  |      |       |
                                                                  v      v       v
                                                               RECOVERED FAILED EXPIRED
                                                                          |
                                                                          v
                                                               ALREADY_RECOVERED
```

Terminal states are `RECOVERED`, `FAILED`, `EXPIRED`, `ALREADY_RECOVERED`,
`REJECTED` and `ABSTAINED`. Every transition is checked; invalid transitions
throw before an executor can be called.

## Retry and audit

The M5 SHA-256 idempotency key remains authoritative. The orchestrator keeps
correlation state, while the recovery service keeps the action/outcome ledger.
If orchestration fails after the service has executed, retrying returns the
existing action and verifies/reconciles it without creating another action.

Orchestration events include correlation ID, opaque merchant/payment
references, timestamp, state, model version, policy version and action ID when
available. The audit API returns copies, so callers cannot mutate stored
records. The flow remains usable with no LLM configured.

## Runtime modes

The default is `SimulationRecoveryExecutor`, with deterministic success,
failure, expiry, already-recovered and verification-timeout scenarios.
`RazorpayTestRecoveryExecutor` is opt-in, requires an `rzp_test_` key, and
verifies a paid Payment Link before counting recovered value. No production
credentials or live execution path is enabled by M7.
