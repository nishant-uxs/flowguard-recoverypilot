# FlowGuard RecoveryPilot 2.0

FlowGuard is a Track 03 proof-of-work project for the Razorpay AI Buildathon:
detect gradual payment degradation, identify a recovery opportunity, and execute
one safe, bounded recovery action in test mode or simulation.

## Status

M7 is complete: the original v1 evaluation remains reproducible, M4.5
provides independent merchant-disjoint evaluation, M5/M6 provide a bounded
simulated recovery loop plus opportunity-value ranking, and M7 adds explicit
orchestration with an explanation-only LLM boundary. The dashboard and
production Razorpay operations are intentionally not implemented.

## Product decision

- Failure family: gradual merchant-level degradation in one payment-method segment.
- Recovery action: one merchant-approved, idempotent test-mode payment-link recovery attempt with a strict expiry.
- Principle: models explain and score; deterministic policy code owns authorization, limits, idempotency and execution.

## Planned architecture

```text
Temporal events
  -> degradation detector
  -> recovery opportunity model
  -> structured explanation
  -> deterministic policy gate
  -> approval / bounded test-mode action
  -> verification
  -> audit ledger and evaluation
```

See [docs/product-spec.md](docs/product-spec.md) and
[docs/architecture.md](docs/architecture.md) and
[docs/agent-architecture.md](docs/agent-architecture.md) for the current
scope.

## Local development

Requirements: Node.js 22+ and npm 11+.

```bash
npm install
npm run typecheck
npm run lint
npm test
```

Generate and validate the M2 temporal dataset:

```bash
npm run generate-data -- --seed 42
npm run validate-data
npm run validate-data -- --merchant mrc_001
npm run evaluate:baseline
npm run evaluate:ml
npm run generate:generalization-data
npm run evaluate:generalization
npm run evaluate:recovery
npm run evaluate:recovery-value
```

Generated artifacts are written to the ignored
`evaluation/datasets/generated/` and
`evaluation/datasets/generalization-v2/` directories.

Start the API and web app in separate terminals:

```bash
npm run dev:api
npm run dev:web
```

The API health endpoint is available at `http://localhost:3001/health`.
The web foundation is available at the Vite development URL shown in the terminal.

## Environment

Copy `.env.example` to `.env` when local secrets are needed. No production
credentials or real-money transactions belong in this repository.

## Evaluation and safety

The final system will include a seeded temporal dataset, a statistical baseline,
shifted holdouts, calibrated ML predictions, failure injection and reproducible
business metrics. Simulated or test-mode monetary outcomes will always be labeled
as such.
