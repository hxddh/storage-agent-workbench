"""The deterministic storage-class simulator (v8: bytes only, no dollars)."""

from app.analysis import cost_sim


def _inventory(**over):
    base = {
        "object_count": 100,
        "total_size": 100 * 10**9,
        "unknown_age_ratio": 0.0,
        "unknown_size_ratio": 0.0,
        "storage_class_distribution": [
            {"value": "STANDARD", "count": 100, "size": 100 * 10**9},
        ],
        "object_age_distribution": [
            {"bucket": "0-7d", "count": 20},
            {"bucket": "365d+", "count": 80},
        ],
        "as_of": "2026-08-01T00:00:00Z",
    }
    base.update(over)
    return base


def test_no_inventory_is_explicit_gap():
    out = cost_sim.simulate(inventory=None)
    assert out["kind"] == "gap"
    assert any(g["code"] == "no_inventory" for g in out["gaps"])
    assert out["timeline"] == []


def test_the_class_mix_moves_with_a_transition_and_never_carries_dollars():
    out = cost_sim.simulate(
        inventory=_inventory(),
        candidates=[{"kind": "transition", "from_class": "STANDARD",
                     "to_class": "STANDARD_IA", "after_days": 1}],
    )
    assert out["kind"] == "simulation"
    assert out["timeline"][0]["candidate_bytes"] == out["timeline"][0]["baseline_bytes"] > 0
    day365 = [p for p in out["timeline"] if p["day"] == 365][0]
    assert day365["candidate_class_bytes"].get("STANDARD_IA", 0) > 0
    assert out["coverage"]["object_count"] == 100
    assert out["coverage"]["inventory_as_of"] == "2026-08-01T00:00:00Z"
    assert "cost" not in str(sorted(out)) and not any("cost" in k for p in out["timeline"] for k in p)


def test_abort_mpu_is_a_gap_not_a_savings_number():
    out = cost_sim.simulate(inventory=_inventory(), candidates=[{"kind": "abort_mpu", "after_days": 7}])
    assert any(g["code"] == "abort_mpu_no_inventory" for g in out["gaps"])
