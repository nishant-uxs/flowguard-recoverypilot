"""Train one small GRU on the exported, leakage-safe sequence dataset.

The script deliberately has no knowledge of degradation truth beyond the
labels supplied in the training input. It records the selected runtime device
so CPU-only environments remain explicit and reproducible.
"""

from __future__ import annotations

import json
import random
import sys
import time
from pathlib import Path


def unavailable(output_path: Path, reason: str) -> None:
    output_path.write_text(
        json.dumps({"status": "unavailable", "reason": reason}, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: train_gru.py INPUT_JSON OUTPUT_JSON")

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    payload = json.loads(input_path.read_text(encoding="utf-8"))

    try:
        import numpy as np
        import torch
        from torch import nn
    except ImportError as error:
        unavailable(output_path, f"PyTorch or NumPy unavailable: {error}")
        return 0

    seed = int(payload.get("seed", 42))
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    try:
        torch.use_deterministic_algorithms(True)
    except RuntimeError:
        pass

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    train = payload["train"]
    all_examples = payload["all"]
    if not train:
        unavailable(output_path, "empty training set")
        return 0

    train_values = np.asarray([example["values"] for example in train], dtype=np.float32)
    all_values = np.asarray([example["values"] for example in all_examples], dtype=np.float32)
    means = train_values.mean(axis=(0, 1), keepdims=True)
    standard_deviations = train_values.std(axis=(0, 1), keepdims=True)
    standard_deviations = np.maximum(standard_deviations, 1e-6)
    train_values = (train_values - means) / standard_deviations
    all_values = (all_values - means) / standard_deviations
    labels = np.asarray([example["label"] for example in train], dtype=np.float32)
    positive_count = max(1, int(labels.sum()))
    negative_count = max(1, len(labels) - positive_count)
    positive_weight = min(10.0, max(1.0, negative_count / positive_count))

    class TemporalGRU(nn.Module):
        def __init__(self, input_size: int, hidden_size: int) -> None:
            super().__init__()
            self.gru = nn.GRU(input_size, hidden_size, batch_first=True)
            self.output = nn.Linear(hidden_size, 1)

        def forward(self, values: torch.Tensor) -> torch.Tensor:
            _, hidden = self.gru(values)
            return self.output(hidden[-1]).squeeze(-1)

    input_size = train_values.shape[2]
    hidden_size = int(payload.get("hiddenSize", 16))
    model = TemporalGRU(input_size, hidden_size).to(device)
    parameter_count = sum(parameter.numel() for parameter in model.parameters())
    train_tensor = torch.from_numpy(train_values).to(device)
    label_tensor = torch.from_numpy(labels).to(device)
    loss_function = nn.BCEWithLogitsLoss(
        pos_weight=torch.tensor(positive_weight, dtype=torch.float32, device=device)
    )
    optimizer = torch.optim.Adam(model.parameters(), lr=float(payload.get("learningRate", 0.003)))
    epochs = int(payload.get("epochs", 40))
    batch_size = int(payload.get("batchSize", 128))
    start_time = time.perf_counter()

    model.train()
    for _ in range(epochs):
        optimizer.zero_grad(set_to_none=True)
        losses = []
        for start in range(0, len(train_tensor), batch_size):
            batch_values = train_tensor[start : start + batch_size]
            batch_labels = label_tensor[start : start + batch_size]
            loss = loss_function(model(batch_values), batch_labels)
            loss.backward()
            losses.append(float(loss.detach().cpu()))
        optimizer.step()

    model.eval()
    all_tensor = torch.from_numpy(all_values).to(device)
    with torch.no_grad():
        logits = torch.cat(
            [model(all_tensor[start : start + batch_size]) for start in range(0, len(all_tensor), batch_size)]
        )
        probabilities = torch.sigmoid(logits).cpu().numpy().tolist()

    predictions = [
        {
            "merchantId": example["merchantId"],
            "endWindow": example["endWindow"],
            "timestamp": example["timestamp"],
            "probability": float(probability),
            "label": example["label"],
        }
        for example, probability in zip(all_examples, probabilities)
    ]
    output_path.write_text(
        json.dumps(
            {
                "status": "trained",
                "modelVersion": payload.get("modelVersion", "m4-gru-v1"),
                "device": str(device),
                "framework": f"torch {torch.__version__}",
                "architecture": "GRU(input_size -> 16) -> Linear(16 -> 1)",
                "parameterCount": parameter_count,
                "batchSize": batch_size,
                "learningRate": float(payload.get("learningRate", 0.003)),
                "epochs": epochs,
                "seed": seed,
                "positiveClassWeight": positive_weight,
                "trainingSeconds": time.perf_counter() - start_time,
                "trainingLoss": losses[-1] if losses else None,
                "predictions": predictions,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
