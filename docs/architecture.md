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
