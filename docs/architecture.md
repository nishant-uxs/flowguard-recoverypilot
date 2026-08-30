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
