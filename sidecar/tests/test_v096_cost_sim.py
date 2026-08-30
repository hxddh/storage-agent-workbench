"""v0.96 — deterministic cost/lifecycle simulator."""

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
    out = cost_sim.simulate(inventory=None, price_table={"confirmed": True})
    assert out["kind"] == "gap"
    assert any(g["code"] == "no_inventory" for g in out["gaps"])
    assert out["monthly_cost"] is None
    assert out["timeline"] == []


def test_unconfirmed_prices_withhold_dollars_not_invent_them():
    out = cost_sim.simulate(
        inventory=_inventory(),
        price_table={"confirmed": False, "storage_gb_month": {"STANDARD": 0.023}},
        candidates=[{"kind": "transition", "from_class": "STANDARD",
                     "to_class": "STANDARD_IA", "after_days": 90}],
    )
    assert out["kind"] == "simulation"
    assert any(g["code"] == "price_unconfirmed" for g in out["gaps"])
    assert out["monthly_cost"] is None
    assert out["monthly_cost_delta"] is None
    assert out["timeline"][0]["candidate_class_bytes"]["STANDARD"] > 0
    assert out["coverage"]["object_count"] == 100
    assert out["coverage"]["inventory_as_of"] == "2026-08-01T00:00:00Z"


def test_confirmed_prices_project_delta_with_coverage():
    prices = {
        "confirmed": True,
        "storage_gb_month": {"STANDARD": 0.023, "STANDARD_IA": 0.0125},
    }
    out = cost_sim.simulate(
        inventory=_inventory(),
        price_table=prices,
        candidates=[{"kind": "transition", "from_class": "STANDARD",
                     "to_class": "STANDARD_IA", "after_days": 1}],
    )
    assert out["kind"] == "simulation"
    assert out["monthly_cost_delta"]["estimate"] is True
    assert out["monthly_cost_delta"]["usd_per_month_at_365d"] < 0
    day365 = [p for p in out["timeline"] if p["day"] == 365][0]
    assert day365["candidate_class_bytes"].get("STANDARD_IA", 0) > 0
    assert "bytes" in out["coverage"]


def test_abort_mpu_is_a_gap_not_a_savings_number():
    out = cost_sim.simulate(
        inventory=_inventory(),
        price_table={"confirmed": True, "storage_gb_month": {"STANDARD": 0.023}},
        candidates=[{"kind": "abort_mpu", "after_days": 7}],
    )
    assert any(g["code"] == "abort_mpu_no_inventory" for g in out["gaps"])
