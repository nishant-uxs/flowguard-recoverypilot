# AI Design — M4 experiment

## Why introduce ML

M3 showed that an interpretable EWMA/CUSUM detector can identify many
degradation episodes while keeping stable-period alerts low, but its test
10-minute lead-time attainment was 0%. M4 therefore tests whether supervised
temporal features can improve early warning without assuming that a neural
model will win.

The experiment is deliberately offline. Its output is a score for evaluation;
it is not a recovery agent, policy engine, LLM, dashboard or Razorpay
integration.

## Inputs and labels

Each example contains four chronological five-minute windows, representing the
20-minute observation period. The label is one when a degraded/severe episode
starts in the following six windows, representing the 30-minute prediction
horizon. Feature values end at the prediction timestamp.

Features include:

- transaction count, smoothed failure rate, success rate and retry rate
- latency p50, p95 and dispersion
- amount mean and dispersion
- rolling failure/latency statistics
- first differences, slopes and temporal trend features
- merchant-relative deviations from the available historical baseline

Merchant IDs, scenario labels, hidden phases and future aggregates are never
features. The scaler is fitted on training examples only.

## Models

The supervised baseline is class-weighted logistic regression over flattened
four-window sequences. It is deterministic and provides a strong sanity check
before considering sequence modeling.

The only neural model is a small single-layer GRU followed by a linear output
head. It is intentionally small enough for a quick reproducible experiment.
The local environment used PyTorch `2.12.0+cpu`; CUDA was unavailable, so no
GPU result is claimed.

## Evaluation and decision gate

Training is chronological. The training set excludes the 15% merchant
holdout. Known validation merchants select the probability threshold and alert
persistence. The test set is evaluated only after that operating point is
frozen.

All models use the M3 episode-level evaluator and the same debouncing/cooldown
logic. We report precision, recall, F1, stable-period false-alert rate,
episode recall, p25/median/p75 lead time, 10-minute early attainment, Brier
score and expected calibration error.

The existing holdout has only one degraded episode. It is reported for
transparency, not as evidence of merchant generalization. Shifted-pattern
evaluation is also withheld until the generator can produce independent
degradation speeds, intensities and traffic conditions.

The baseline is intentionally interpretable and exists to establish whether
more complex ML provides measurable incremental value. A model is not promoted
because it improves F1 alone; it must improve early detection and episode
recall without unacceptable false alerts.

## Synthetic-data limitations

These results come from a deterministic synthetic generator with one
degradation family. Event volume, latency and failure changes are generated
from known distributions and may not represent production behavior. Scores
must not be described as production payment-failure accuracy or recovered
revenue. The next credible evaluation improvement is a separately generated
merchant-disjoint and shifted-pattern dataset, not a larger neural network.
