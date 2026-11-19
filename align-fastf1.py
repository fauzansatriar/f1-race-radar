"""Align the bundled OpenF1 GPS points with car-data timestamps using FastF1."""

import json
from bisect import bisect_left
from itertools import pairwise
from pathlib import Path

import pandas as pd
from fastf1.core import Telemetry

ROOT = Path(__file__).resolve().parent / "src"


def align(driver):
    positions = driver["locations"]
    stamps = [row[0] for row in positions]
    targets = [row[0] for row in driver["telemetry"]]
    cuts = [0, *(i for i, (a, b) in enumerate(pairwise(stamps), 1) if b - a > 1500), len(stamps)]
    samples = []
    for start, end in pairwise(cuts):
        if end - start < 3:
            continue
        points = positions[start:end]
        source = {time: (x, y) for time, x, y in points}
        extra = [time for time in targets if points[0][0] < time < points[-1][0] and time not in source]
        if not extra:
            continue
        data = pd.DataFrame.from_dict(source, orient="index", columns=["X", "Y"], dtype=float)
        data = data.reindex(sorted([*source, *extra]))
        data["SessionTime"] = pd.to_timedelta(data.index - points[0][0], unit="ms")
        aligned = Telemetry(data).fill_missing()
        times = stamps[start:end]
        for time in extra:
            i = bisect_left(times, time)
            left, right = points[i - 1], points[i]
            coordinates = [
                round(max(min(a, b), min(max(a, b), value)), 2)
                for a, b, value in zip(left[1:], right[1:], aligned.loc[time, ["X", "Y"]])
            ]
            samples.append([time, *coordinates])
    return samples


if __name__ == "__main__":
    cache_path = ROOT / "race-cache.json"
    cache = json.loads(cache_path.read_text(encoding="utf-8"))
    output = {"session": cache["session"], "drivers": {
        key: align(driver) for key, driver in cache["participants"].items()
    }}
    (ROOT / "fastf1-locations.json").write_text(json.dumps(output, separators=(",", ":")) + "\n", encoding="utf-8")
