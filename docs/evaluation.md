# M2 — Temporal Dataset and Evaluation Plan

## Scope

M2 creates synthetic temporal payment events for the single locked failure
family: **gradual merchant-level degradation in the UPI Intent segment**.
UPI Intent is the target because it is a high-volume payment segment where
success, latency and failure-category changes can plausibly emerge over time.
Cards, netbanking and wallet segments are generated as controls and noise.

This is synthetic data and does not represent production Razorpay data.

## Generation model

The generator creates multiple merchants, each with different traffic volume,
baseline failure rate, amount distribution, latency and noise. Events are
sampled from a latent merchant/segment process in five-minute windows; they
are not independent random rows.

Degraded target merchants move through:

```text
NORMAL → EARLY_SIGNAL → DEGRADED → SEVERE → optional RECOVERY
```

Some merchants are stable, noisy, low-traffic or high-traffic. Only the UPI
Intent stream of degraded merchants receives the sustained target state.
The state is never written into `PaymentEvent`.

Observable signals include payment status, failure category when observable,
latency, retry count, amount, timestamp and payment-method segment. Shared
window shocks make failure rate, latency and volume correlated without making
any one field a perfect label.

## Detection target

The future model will use a 20-minute observation window to predict whether the
UPI Intent stream will enter a sustained degraded/severe state during the next
30 minutes. Sustained degradation means at least three consecutive five-minute
windows in the hidden `DEGRADED` or `SEVERE` state. The desired detection lead
time is 10 minutes.

The labels are derived from future latent intervals in `truth.json`; they are
not included in `events.jsonl`.

## Ground truth and leakage prevention

`events.jsonl` contains only observation-time `PaymentEvent` objects. Separate
`truth.json` contains scenario classes and degradation intervals. No raw event
contains `isDegraded`, `degradationState`, recovery outcomes, future counts,
scenario class or other hidden labels.

The generator uses random, non-semantic event IDs. Merchant IDs are assigned
profiles after a seeded shuffle. Degradation start times vary by merchant.
The validation command checks forbidden keys, schema validity, duplicate IDs,
chronology, split overlap and whether a trivial single-feature probe is
near-perfect.

## Reproducibility and exports

```bash
npm run generate-data -- --seed 42
npm run validate-data
npm run validate-data -- --merchant mrc_001
```

The command writes ignored artifacts to `evaluation/datasets/generated/`:

- `events.jsonl`: raw validated events
- `truth.json`: hidden scenario truth
- `splits.json`: temporal split manifest and metadata

The default dataset has 120 merchants, 72 five-minute windows and six payment
segments. The exact event count is printed by the generator and reported by
the validation command.

## Split strategy

The primary manifest has disjoint temporal windows:

- train: first 60% of windows
- validation: next 20%
- test: final 20%

No random row-level split is used. The manifest also records a merchant
holdout group for a later generalization experiment. Future model evaluation
must report both temporal performance and merchant-held-out performance.

## M2 sanity checks only

M2 reports merchant and event counts, segment coverage, scenario balance,
status/failure rates, latency and amount summaries, degradation durations,
missing optional values, duplicates, chronological violations and a
single-feature trivial-probe result. It does not implement EWMA/CUSUM, ML,
calibration or business recovery metrics.
