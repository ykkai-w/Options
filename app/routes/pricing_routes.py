"""Pricing & visualization API. All inputs validated via Pydantic."""
import numpy as np
from fastapi import APIRouter, HTTPException

from ..strategies import StrategyPayload, list_presets, build_preset
from ..pricing import (
    aggregate_pnl_at_expiry, aggregate_pnl_at, aggregate_greeks,
    bs_price, bs_greeks, implied_vol, find_breakevens, prob_of_profit,
    EPS_T,
)

router = APIRouter(prefix="/api", tags=["pricing"])


@router.get("/presets")
def get_presets():
    return {"presets": list_presets()}


@router.post("/presets/{key}/build")
def build_preset_payload(key: str, payload: dict):
    """Returns leg list for preset, seeded with current S0/sigma."""
    S0 = float(payload.get("S0", 100))
    sigma = float(payload.get("sigma", 0.25))
    legs = build_preset(key, S0, sigma)
    if not legs:
        raise HTTPException(404, f"Unknown preset: {key}")
    return {"legs": legs}


def _spot_grid(S0: float, n: int = 161) -> np.ndarray:
    lo = max(S0 * 0.5, 1e-3)
    hi = S0 * 1.5
    return np.linspace(lo, hi, n)


@router.post("/compute")
def compute(payload: StrategyPayload):
    """Main endpoint: returns expiry P&L, current P&L (and a few intermediate
    times), aggregate Greeks vs spot, summary statistics, and per-leg payoffs."""
    from ..pricing import leg_payoff_at_expiry, leg_entry_cost
    legs = [l.to_leg() for l in payload.legs]
    m = payload.market

    S = _spot_grid(m.S0)

    # Expiry P&L
    pnl_expiry = aggregate_pnl_at_expiry(legs, S, m.S0, m.T, m.r, m.q, m.sigma)

    # Per-leg P&L at expiry (so frontend can draw dashed-line legs + solid total)
    legs_pnl = []
    for leg in legs:
        payoff = leg_payoff_at_expiry(leg, S)
        cost = leg_entry_cost(leg, m.S0, m.T, m.r, m.q, m.sigma)
        leg_pnl = (payoff - cost).tolist()
        side = "long" if leg.qty > 0 else "short"
        kind_label = {"call": "Call", "put": "Put", "underlying": "现货", "forward": "远期"}[leg.kind]
        if leg.kind in ("call", "put"):
            label_default = f"{side} {kind_label} K={leg.K:g}"
        elif leg.kind == "underlying":
            label_default = f"{side} 现货"
        else:
            label_default = f"{side} 远期 F={leg.forward_price or 0:g}"
        legs_pnl.append({
            "label": leg.label or label_default,
            "kind": leg.kind,
            "qty": leg.qty,
            "K": leg.K,
            "pnl": leg_pnl,
        })

    # Time slices: now, T/2, T/4, T/8 (capped at expiry)
    slice_fracs = [1.0, 0.5, 0.25, 0.0]  # 0 == expiry (recomputed for symmetry)
    slices = []
    for frac in slice_fracs:
        T_remaining = max(m.T * frac, 0.0)
        if T_remaining < EPS_T:
            curve = aggregate_pnl_at_expiry(legs, S, m.S0, m.T, m.r, m.q, m.sigma)
            label = "到期"
        else:
            curve = aggregate_pnl_at(legs, S, T_remaining, m.S0, m.T, m.r, m.q, m.sigma)
            days = int(round(T_remaining * 365))
            label = f"剩 {days} 天" if frac < 1.0 else "当前"
        slices.append({"T_remaining": T_remaining, "label": label, "pnl": curve.tolist()})

    # Aggregate Greeks at "now" (full T)
    greeks = aggregate_greeks(legs, S, m.T, m.r, m.q, m.sigma)
    greeks_out = {k: v.tolist() for k, v in greeks.items()}

    # Summary stats
    breakevens = find_breakevens(S, pnl_expiry)
    max_profit = float(np.max(pnl_expiry))
    max_loss = float(np.min(pnl_expiry))
    pop = prob_of_profit(m.S0, m.T, m.r, m.q, m.sigma, S, pnl_expiry)
    net_premium = -float(pnl_expiry[np.argmin(np.abs(S - m.S0))]) if False else None
    # Net cost (positive = paid, negative = collected): compute fresh
    from ..pricing import leg_entry_cost
    net_cost = sum(leg_entry_cost(leg, m.S0, m.T, m.r, m.q, m.sigma) for leg in legs)

    # Greeks at S0
    gi = int(np.argmin(np.abs(S - m.S0)))
    greeks_at_spot = {k: float(v[gi]) for k, v in greeks.items()}

    return {
        "S": S.tolist(),
        "pnl_expiry": pnl_expiry.tolist(),
        "legs_pnl": legs_pnl,
        "slices": slices,
        "greeks": greeks_out,
        "summary": {
            "max_profit": None if not np.isfinite(max_profit) else max_profit,
            "max_loss": None if not np.isfinite(max_loss) else max_loss,
            "breakevens": breakevens,
            "net_cost": float(net_cost),       # +ve = paid premium / -ve = collected
            "prob_profit": pop,
            "greeks_at_spot": greeks_at_spot,
        },
    }


@router.post("/compute_surface")
def compute_surface(payload: StrategyPayload, n_spot: int = 41, n_time: int = 31):
    """3D surface: P&L over (spot, time-to-expiry)."""
    legs = [l.to_leg() for l in payload.legs]
    m = payload.market

    S = _spot_grid(m.S0, n=max(21, min(n_spot, 81)))
    Ts = np.linspace(0.0, m.T, max(11, min(n_time, 61)))

    Z = np.zeros((len(Ts), len(S)))
    for i, t in enumerate(Ts):
        if t <= EPS_T:
            Z[i] = aggregate_pnl_at_expiry(legs, S, m.S0, m.T, m.r, m.q, m.sigma)
        else:
            Z[i] = aggregate_pnl_at(legs, S, t, m.S0, m.T, m.r, m.q, m.sigma)
    return {"S": S.tolist(), "T": Ts.tolist(), "Z": Z.tolist()}


@router.post("/iv")
def compute_iv(payload: dict):
    """Implied vol from market price."""
    try:
        price = float(payload["price"])
        S = float(payload["S"]); K = float(payload["K"])
        T = float(payload["T"]); r = float(payload.get("r", 0.03))
        q = float(payload.get("q", 0.0))
        kind = payload["kind"]
        assert kind in ("call", "put")
    except (KeyError, ValueError, AssertionError):
        raise HTTPException(400, "invalid payload")
    iv = implied_vol(price, S, K, T, r, q, kind)
    return {"iv": iv}
