"""Black-Scholes pricing, Greeks, and multi-leg strategy aggregation.

Conventions
-----------
S    : underlying spot price
K    : strike
T    : time to expiry in years
r    : risk-free rate (continuously compounded)
q    : continuous dividend yield
sigma: implied volatility (annualised)

Per-leg `qty` is signed: +1 long, -1 short. Multipliers (e.g. 100 for US equities) are
applied at the strategy layer, not here, so the maths stay clean.
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import List, Literal, Optional
import math
import numpy as np
from scipy.stats import norm

EPS_T = 1e-6  # treat T below this as "expired now"


# ============================================================================
# Vanilla European: closed-form
# ============================================================================
def _d1_d2(S, K, T, r, q, sigma):
    """Vectorised d1/d2. Caller ensures T > 0 and sigma > 0."""
    sqrtT = np.sqrt(T)
    d1 = (np.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT)
    d2 = d1 - sigma * sqrtT
    return d1, d2


def bs_price(S, K, T, r, q, sigma, kind: Literal["call", "put"]):
    S, K, T, r, q, sigma = map(np.asarray, (S, K, T, r, q, sigma))
    out = np.zeros_like(S, dtype=float) if S.ndim else np.array(0.0)
    expired = T <= EPS_T
    live = ~expired
    if np.any(expired):
        if kind == "call":
            out = np.where(expired, np.maximum(S - K, 0.0), out)
        else:
            out = np.where(expired, np.maximum(K - S, 0.0), out)
    if np.any(live):
        d1, d2 = _d1_d2(np.where(live, S, 1.0), np.where(live, K, 1.0),
                        np.where(live, T, 1.0), np.where(live, r, 0.0),
                        np.where(live, q, 0.0), np.where(live, sigma, 0.2))
        if kind == "call":
            val = S * np.exp(-q * T) * norm.cdf(d1) - K * np.exp(-r * T) * norm.cdf(d2)
        else:
            val = K * np.exp(-r * T) * norm.cdf(-d2) - S * np.exp(-q * T) * norm.cdf(-d1)
        out = np.where(live, val, out)
    return out


def bs_greeks(S, K, T, r, q, sigma, kind: Literal["call", "put"]):
    """Returns dict with delta, gamma, vega (per 1.0 vol move), theta (per year), rho (per 1.0 rate)."""
    S = np.asarray(S, dtype=float)
    K_a = np.asarray(K, dtype=float)
    T_a = np.asarray(T, dtype=float)
    r_a = np.asarray(r, dtype=float)
    q_a = np.asarray(q, dtype=float)
    s_a = np.asarray(sigma, dtype=float)

    expired = T_a <= EPS_T
    live = ~expired

    delta = np.zeros_like(S)
    gamma = np.zeros_like(S)
    vega = np.zeros_like(S)
    theta = np.zeros_like(S)
    rho = np.zeros_like(S)

    if np.any(expired):
        if kind == "call":
            delta = np.where(expired, np.where(S > K_a, 1.0, 0.0), delta)
        else:
            delta = np.where(expired, np.where(S < K_a, -1.0, 0.0), delta)

    if np.any(live):
        Sl = np.where(live, S, 1.0)
        Kl = np.where(live, K_a, 1.0)
        Tl = np.where(live, T_a, 1.0)
        rl = np.where(live, r_a, 0.0)
        ql = np.where(live, q_a, 0.0)
        sl = np.where(live, s_a, 0.2)
        sqrtT = np.sqrt(Tl)
        d1, d2 = _d1_d2(Sl, Kl, Tl, rl, ql, sl)
        n_d1 = norm.pdf(d1)
        gamma_l = np.exp(-ql * Tl) * n_d1 / (Sl * sl * sqrtT)
        vega_l = Sl * np.exp(-ql * Tl) * n_d1 * sqrtT
        if kind == "call":
            delta_l = np.exp(-ql * Tl) * norm.cdf(d1)
            theta_l = (-Sl * np.exp(-ql * Tl) * n_d1 * sl / (2 * sqrtT)
                       - rl * Kl * np.exp(-rl * Tl) * norm.cdf(d2)
                       + ql * Sl * np.exp(-ql * Tl) * norm.cdf(d1))
            rho_l = Kl * Tl * np.exp(-rl * Tl) * norm.cdf(d2)
        else:
            delta_l = -np.exp(-ql * Tl) * norm.cdf(-d1)
            theta_l = (-Sl * np.exp(-ql * Tl) * n_d1 * sl / (2 * sqrtT)
                       + rl * Kl * np.exp(-rl * Tl) * norm.cdf(-d2)
                       - ql * Sl * np.exp(-ql * Tl) * norm.cdf(-d1))
            rho_l = -Kl * Tl * np.exp(-rl * Tl) * norm.cdf(-d2)
        delta = np.where(live, delta_l, delta)
        gamma = np.where(live, gamma_l, gamma)
        vega = np.where(live, vega_l, vega)
        theta = np.where(live, theta_l, theta)
        rho = np.where(live, rho_l, rho)

    return {"delta": delta, "gamma": gamma, "vega": vega, "theta": theta, "rho": rho}


# ============================================================================
# Implied volatility (Brent)
# ============================================================================
def implied_vol(price_target: float, S: float, K: float, T: float, r: float, q: float,
                kind: Literal["call", "put"]) -> Optional[float]:
    if T <= EPS_T or price_target <= 0:
        return None
    intrinsic = max(S - K, 0.0) if kind == "call" else max(K - S, 0.0)
    if price_target < intrinsic - 1e-8:
        return None
    from scipy.optimize import brentq
    def f(sig):
        return float(bs_price(S, K, T, r, q, sig, kind)) - price_target
    try:
        return brentq(f, 1e-4, 5.0, maxiter=100, xtol=1e-6)
    except (ValueError, RuntimeError):
        return None


# ============================================================================
# Strategy legs and aggregation
# ============================================================================
LegKind = Literal["call", "put", "underlying", "forward"]


@dataclass
class Leg:
    kind: LegKind
    qty: float                       # signed: +long, -short
    K: Optional[float] = None        # None for underlying
    sigma: Optional[float] = None    # per-leg IV; None → use global
    premium: Optional[float] = None  # observed premium; if None we use BS(sigma)
    T: Optional[float] = None        # per-leg expiry; None → strategy T
    forward_price: Optional[float] = None  # delivery price for forward leg
    label: Optional[str] = None


def leg_payoff_at_expiry(leg: Leg, S_grid: np.ndarray) -> np.ndarray:
    """P&L at the leg's own expiry, ignoring premium (premium handled separately)."""
    if leg.kind == "call":
        return leg.qty * np.maximum(S_grid - leg.K, 0.0)
    if leg.kind == "put":
        return leg.qty * np.maximum(leg.K - S_grid, 0.0)
    if leg.kind == "underlying":
        return leg.qty * S_grid  # raw value; entry price subtracted via "premium" semantics below
    if leg.kind == "forward":
        return leg.qty * (S_grid - (leg.forward_price or 0.0))
    raise ValueError(f"unknown leg kind: {leg.kind}")


def leg_entry_cost(leg: Leg, S0: float, T: float, r: float, q: float, sigma_global: float) -> float:
    """Net cash you pay to open this leg (positive = outflow)."""
    if leg.premium is not None:
        # User-provided premium / entry price
        if leg.kind in ("call", "put"):
            return leg.qty * leg.premium
        if leg.kind == "underlying":
            return leg.qty * leg.premium  # premium == entry spot
        if leg.kind == "forward":
            return 0.0  # forwards have no upfront premium by convention
    # Fallback: model-derived
    if leg.kind == "call":
        return leg.qty * float(bs_price(S0, leg.K, leg.T or T, r, q, leg.sigma or sigma_global, "call"))
    if leg.kind == "put":
        return leg.qty * float(bs_price(S0, leg.K, leg.T or T, r, q, leg.sigma or sigma_global, "put"))
    if leg.kind == "underlying":
        return leg.qty * S0
    if leg.kind == "forward":
        return 0.0
    return 0.0


def leg_price_at(leg: Leg, S_grid: np.ndarray, T_remaining: float, r: float, q: float,
                 sigma_global: float) -> np.ndarray:
    """Mark-to-model leg value at time-to-expiry T_remaining."""
    sigma = leg.sigma or sigma_global
    leg_T = leg.T if leg.T is not None else T_remaining
    # If the leg's own expiry has been reached/passed, fall back to intrinsic.
    eff_T = max(leg_T - (leg_T - T_remaining), 0.0) if leg.T is not None else T_remaining
    # Simpler: assume strategy clock advances uniformly: caller passes T_remaining as
    # "common time-to-expiry"; per-leg T just shifts effective T.
    eff_T = max(min(leg_T, T_remaining), 0.0)

    if leg.kind == "call":
        return leg.qty * bs_price(S_grid, leg.K, eff_T, r, q, sigma, "call")
    if leg.kind == "put":
        return leg.qty * bs_price(S_grid, leg.K, eff_T, r, q, sigma, "put")
    if leg.kind == "underlying":
        return leg.qty * S_grid
    if leg.kind == "forward":
        # PV of forward = (S - F * e^{-r T}) actually; using simple S - F for educational clarity
        return leg.qty * (S_grid - (leg.forward_price or 0.0) * np.exp(-r * eff_T))
    return np.zeros_like(S_grid)


def leg_greeks_at(leg: Leg, S_grid: np.ndarray, T_remaining: float, r: float, q: float,
                  sigma_global: float):
    sigma = leg.sigma or sigma_global
    eff_T = max(min(leg.T if leg.T is not None else T_remaining, T_remaining), 0.0)
    if leg.kind in ("call", "put"):
        g = bs_greeks(S_grid, leg.K, eff_T, r, q, sigma, leg.kind)
        return {k: leg.qty * v for k, v in g.items()}
    if leg.kind == "underlying":
        return {"delta": np.full_like(S_grid, leg.qty, dtype=float),
                "gamma": np.zeros_like(S_grid),
                "vega":  np.zeros_like(S_grid),
                "theta": np.zeros_like(S_grid),
                "rho":   np.zeros_like(S_grid)}
    if leg.kind == "forward":
        return {"delta": np.full_like(S_grid, leg.qty, dtype=float),
                "gamma": np.zeros_like(S_grid),
                "vega":  np.zeros_like(S_grid),
                "theta": np.zeros_like(S_grid),
                "rho":   np.full_like(S_grid, leg.qty * (leg.forward_price or 0.0) * eff_T * np.exp(-r * eff_T), dtype=float)}
    return {k: np.zeros_like(S_grid) for k in ("delta", "gamma", "vega", "theta", "rho")}


# ============================================================================
# Strategy-level summary
# ============================================================================
def aggregate_pnl_at_expiry(legs: List[Leg], S_grid: np.ndarray, S0: float, T: float,
                            r: float, q: float, sigma_global: float) -> np.ndarray:
    """Total P&L vs spot at expiry."""
    total_payoff = np.zeros_like(S_grid)
    total_cost = 0.0
    for leg in legs:
        total_payoff += leg_payoff_at_expiry(leg, S_grid)
        total_cost += leg_entry_cost(leg, S0, T, r, q, sigma_global)
    return total_payoff - total_cost


def aggregate_value_at(legs: List[Leg], S_grid: np.ndarray, T_remaining: float,
                       r: float, q: float, sigma_global: float) -> np.ndarray:
    total = np.zeros_like(S_grid)
    for leg in legs:
        total += leg_price_at(leg, S_grid, T_remaining, r, q, sigma_global)
    return total


def aggregate_pnl_at(legs: List[Leg], S_grid: np.ndarray, T_remaining: float,
                     S0: float, T: float, r: float, q: float, sigma_global: float) -> np.ndarray:
    value_now = aggregate_value_at(legs, S_grid, T_remaining, r, q, sigma_global)
    cost = sum(leg_entry_cost(leg, S0, T, r, q, sigma_global) for leg in legs)
    return value_now - cost


def aggregate_greeks(legs: List[Leg], S_grid: np.ndarray, T_remaining: float,
                     r: float, q: float, sigma_global: float):
    totals = {"delta": np.zeros_like(S_grid), "gamma": np.zeros_like(S_grid),
              "vega": np.zeros_like(S_grid), "theta": np.zeros_like(S_grid),
              "rho": np.zeros_like(S_grid)}
    for leg in legs:
        g = leg_greeks_at(leg, S_grid, T_remaining, r, q, sigma_global)
        for k in totals:
            totals[k] = totals[k] + g[k]
    return totals


def find_breakevens(S_grid: np.ndarray, pnl: np.ndarray) -> List[float]:
    """Linear interpolation between sign changes."""
    out = []
    for i in range(len(pnl) - 1):
        if pnl[i] == 0:
            out.append(float(S_grid[i]))
        elif pnl[i] * pnl[i + 1] < 0:
            x0, x1, y0, y1 = S_grid[i], S_grid[i + 1], pnl[i], pnl[i + 1]
            out.append(float(x0 - y0 * (x1 - x0) / (y1 - y0)))
    if pnl[-1] == 0:
        out.append(float(S_grid[-1]))
    return out


def prob_of_profit(S0: float, T: float, r: float, q: float, sigma: float,
                   S_grid: np.ndarray, pnl: np.ndarray) -> float:
    """Lognormal probability that terminal spot lands in profit regions."""
    if T <= EPS_T or sigma <= 0:
        # Just a thresholded sample at S0
        idx = int(np.searchsorted(S_grid, S0))
        idx = min(max(idx, 0), len(pnl) - 1)
        return 1.0 if pnl[idx] > 0 else 0.0
    drift = math.log(S0) + (r - q - 0.5 * sigma ** 2) * T
    vol = sigma * math.sqrt(T)
    cdf_at = lambda x: norm.cdf((math.log(x) - drift) / vol) if x > 0 else 0.0
    profit_prob = 0.0
    in_profit = pnl > 0
    i = 0
    n = len(S_grid)
    while i < n:
        if in_profit[i]:
            j = i
            while j < n and in_profit[j]:
                j += 1
            lo = float(S_grid[i])
            hi = float(S_grid[j - 1])
            profit_prob += cdf_at(hi) - cdf_at(lo)
            i = j
        else:
            i += 1
    return float(max(0.0, min(1.0, profit_prob)))
