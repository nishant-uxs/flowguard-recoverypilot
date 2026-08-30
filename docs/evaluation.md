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

## M3 baseline

The baseline consumes only the target UPI Intent stream. It aggregates each
five-minute window and uses a three-window rolling failure rate and weighted
latency average. The rolling failure rate uses a fixed four-attempt, 4% prior
to reduce extreme small-sample swings without using future data.

For each merchant, the first 12 windows are the historical warmup baseline.
They are used to calculate a merchant-specific mean and standard deviation for
the two rolling features. No degraded-period data is used in that calibration.

The detector uses positive deviations for an EWMA:

```text
EWMA_t = alpha * score_t + (1 - alpha) * EWMA_(t-1)
```

It also uses a one-sided upward CUSUM over the signed weighted deviation:

```text
CUSUM_t = max(0, CUSUM_(t-1) + deviation_t - reference)
```

An alert requires the configured EWMA or CUSUM threshold for the configured
number of consecutive windows. A three-window recovery reset, six-window
cooldown and in-episode state debounce repeated signals into one episode.

Candidate alpha, thresholds and persistence are selected on validation only.
The test period is untouched until the final run. Metrics are episode-level:
precision, recall, F1, false-alert rate in stable windows, alert volume,
detected/missed episodes and detection lead time. A global rolling failure-rate
threshold is reported as a naive comparator.

Run the baseline with:

```bash
npm run evaluate:baseline
```

This writes ignored machine-readable and human-readable artifacts to
`evaluation/results/`. The baseline is intentionally interpretable and exists
to establish whether more complex ML provides measurable incremental value.

## M4 temporal ML experiment

M4 adds supervised models only as an experiment against the M3 reference. The
feature pipeline builds four chronological five-minute inputs and labels each
prediction from future degradation onset in the next six windows. Inputs stop
at the prediction timestamp; labels are never passed to feature construction.

The feature set contains transaction count, smoothed failure/success rates,
latency p50/p95/standard deviation, amount and retry statistics, rolling
statistics, deltas, slopes and merchant-relative z-scores. Merchant IDs,
scenario labels and future aggregates are excluded. Feature scaling and
operating thresholds are fitted on training/validation data only.

The first supervised model is a deterministic, class-weighted logistic
regression over flattened sequences. The neural experiment is one small
PyTorch GRU over the same sequences. The local environment reported
`torch 2.12.0+cpu` and no CUDA device, so the experiment records CPU execution
and makes no GPU claim. It does not store a checkpoint.

The same episode-level metrics, persistence and cooldown are used for naive,
EWMA/CUSUM, logistic and GRU outputs. Probability models additionally report
Brier score and expected calibration error. Thresholds are selected on known
validation merchants, then frozen for test. The 18-merchant holdout is
reported separately, but its single degradation episode is statistically
insufficient for a generalization claim. Shifted-pattern results are not
fabricated because the M2 generator currently exposes only one degradation
mechanism.

Run the experiment with:

```bash
npm run evaluate:ml
```

It writes ignored `evaluation/results/ml-experiment.json` and
`evaluation/results/ml-experiment-report.md`. The baseline remains the
reference: a neural model earns inclusion only through meaningful improvement
in early detection and episode recall without unacceptable false alerts.

## M4.5 independent evaluation hardening

M4's GRU result exposed a protocol weakness: F1 could be perfect while useful
early warning remained poor. M4.5 does not modify the v1 dataset or its
results. It adds protocol version `m4.5-v2` under
`evaluation/generalization/`, with 240 independently generated merchants,
known mechanisms A/B/C and a merchant-disjoint holdout containing shifted and
stress mechanisms D/J.

The v2 mechanisms include gradual failure, latency-first, volume-plus-failure,
short-signal, slow low-amplitude, fast, noisy, temporary recovery,
cross-segment confounding and a target baseline shift without target truth.
Only A/B/C are used for known-merchant training; D/J and the other shifted
families are reserved for holdout evaluation. The generator uses opaque IDs,
randomized episode timing, multiple merchant traffic classes and repeated
episodes for known merchants. `npm run generate:generalization-data` exports
the ignored v2 dataset.

The v2 sequence splitter purges each boundary by the four-window observation
length, so no raw input window is reused between train, validation and test.
The original M4 splitter is intentionally unchanged for v1 reproducibility.

The final target remains future sustained degradation onset within six
five-minute windows after a four-window observation. The hardening scorer uses
one earliest unused alert per episode, a 30-minute prediction horizon and a
30-minute useful intervention window. Alerts after that window are not
credited. It separately reports early alerts, late-useful alerts, missed
episodes, unmatched false alerts, false alert episodes, and duplicate signals.
Lead-time metrics include p25/median/p75, mean lead, at least 5/10/20 minutes
early, and a normalized lead-time utility.

Utility is an explicitly parameterized evaluation assumption, not money:
`utility = early_minutes × early_value − false_alerts × false_alert_cost −
missed_episodes × missed_episode_cost`. The report runs sensitivity cases for
false-alert cost, missed-episode cost and early value. Calibration uses Platt
scaling fit on known validation predictions only; test predictions are never
used for calibration or threshold selection.

Run the independent experiment with:

```bash
npm run evaluate:generalization
```

It writes ignored `generalization-report.json`,
`generalization-report.md` and `experiment-manifest.json`. The report includes
scenario/merchant disjointness, simple artifact probes, naive/EWMA/logistic/GRU
comparisons, ablations, calibration, sensitivity and explicit limitations.
The single-feature probe is a screening audit rather than proof against every
multivariate artifact. Synthetic v2 evidence is not production readiness,
revenue recovery, or proof of broad merchant generalization.
