"""Preset strategy library + payload validation."""
from __future__ import annotations
from typing import List, Dict, Any
from pydantic import BaseModel, Field, field_validator
from .pricing import Leg


class LegIn(BaseModel):
    kind: str = Field(..., pattern=r"^(call|put|underlying|forward)$")
    qty: float
    K: float | None = None
    sigma: float | None = None
    premium: float | None = None
    T: float | None = None
    forward_price: float | None = None
    label: str | None = None

    @field_validator("qty")
    @classmethod
    def _qty_nonzero(cls, v):
        if v == 0:
            raise ValueError("qty must be non-zero")
        return v

    def to_leg(self) -> Leg:
        return Leg(kind=self.kind, qty=self.qty, K=self.K, sigma=self.sigma,
                   premium=self.premium, T=self.T, forward_price=self.forward_price,
                   label=self.label)


class MarketParams(BaseModel):
    S0: float = Field(..., gt=0)
    T: float = Field(..., ge=0)            # years to expiry
    r: float = 0.03
    q: float = 0.0
    sigma: float = Field(0.25, gt=0, le=5)


class StrategyPayload(BaseModel):
    market: MarketParams
    legs: List[LegIn] = Field(..., min_length=1, max_length=20)
    name: str | None = None
    description: str | None = None


# ----------------------------------------------------------------------------
# Preset library: returns leg dicts (not Leg objects) so the frontend can
# round-trip them through forms. K/sigma are seeded relative to S0/sigma_global.
# ----------------------------------------------------------------------------
def _preset_bull_call_spread(S0, sigma):
    return [
        {"kind": "call", "qty": 1, "K": round(S0, 2),         "sigma": sigma, "label": "Long Call ATM"},
        {"kind": "call", "qty": -1, "K": round(S0 * 1.10, 2), "sigma": sigma, "label": "Short Call OTM"},
    ]

def _preset_bear_put_spread(S0, sigma):
    return [
        {"kind": "put", "qty": 1,  "K": round(S0, 2),         "sigma": sigma, "label": "Long Put ATM"},
        {"kind": "put", "qty": -1, "K": round(S0 * 0.90, 2),  "sigma": sigma, "label": "Short Put OTM"},
    ]

def _preset_bull_put_spread(S0, sigma):
    return [
        {"kind": "put", "qty": -1, "K": round(S0, 2),         "sigma": sigma, "label": "Short Put ATM"},
        {"kind": "put", "qty": 1,  "K": round(S0 * 0.90, 2),  "sigma": sigma, "label": "Long Put OTM"},
    ]

def _preset_bear_call_spread(S0, sigma):
    return [
        {"kind": "call", "qty": -1, "K": round(S0, 2),        "sigma": sigma, "label": "Short Call ATM"},
        {"kind": "call", "qty": 1,  "K": round(S0 * 1.10, 2), "sigma": sigma, "label": "Long Call OTM"},
    ]

def _preset_long_straddle(S0, sigma):
    return [
        {"kind": "call", "qty": 1, "K": round(S0, 2), "sigma": sigma, "label": "Long Call ATM"},
        {"kind": "put",  "qty": 1, "K": round(S0, 2), "sigma": sigma, "label": "Long Put ATM"},
    ]

def _preset_short_straddle(S0, sigma):
    return [
        {"kind": "call", "qty": -1, "K": round(S0, 2), "sigma": sigma, "label": "Short Call ATM"},
        {"kind": "put",  "qty": -1, "K": round(S0, 2), "sigma": sigma, "label": "Short Put ATM"},
    ]

def _preset_long_strangle(S0, sigma):
    return [
        {"kind": "call", "qty": 1, "K": round(S0 * 1.05, 2), "sigma": sigma, "label": "Long Call OTM"},
        {"kind": "put",  "qty": 1, "K": round(S0 * 0.95, 2), "sigma": sigma, "label": "Long Put OTM"},
    ]

def _preset_short_strangle(S0, sigma):
    return [
        {"kind": "call", "qty": -1, "K": round(S0 * 1.05, 2), "sigma": sigma, "label": "Short Call OTM"},
        {"kind": "put",  "qty": -1, "K": round(S0 * 0.95, 2), "sigma": sigma, "label": "Short Put OTM"},
    ]

def _preset_long_call_butterfly(S0, sigma):
    return [
        {"kind": "call", "qty": 1,  "K": round(S0 * 0.95, 2), "sigma": sigma, "label": "Long Call ITM"},
        {"kind": "call", "qty": -2, "K": round(S0, 2),        "sigma": sigma, "label": "Short Call ATM ×2"},
        {"kind": "call", "qty": 1,  "K": round(S0 * 1.05, 2), "sigma": sigma, "label": "Long Call OTM"},
    ]

def _preset_long_put_butterfly(S0, sigma):
    return [
        {"kind": "put", "qty": 1,  "K": round(S0 * 1.05, 2), "sigma": sigma, "label": "Long Put ITM"},
        {"kind": "put", "qty": -2, "K": round(S0, 2),        "sigma": sigma, "label": "Short Put ATM ×2"},
        {"kind": "put", "qty": 1,  "K": round(S0 * 0.95, 2), "sigma": sigma, "label": "Long Put OTM"},
    ]

def _preset_iron_butterfly(S0, sigma):
    return [
        {"kind": "put",  "qty": 1,  "K": round(S0 * 0.90, 2), "sigma": sigma, "label": "Long Put OTM"},
        {"kind": "put",  "qty": -1, "K": round(S0, 2),        "sigma": sigma, "label": "Short Put ATM"},
        {"kind": "call", "qty": -1, "K": round(S0, 2),        "sigma": sigma, "label": "Short Call ATM"},
        {"kind": "call", "qty": 1,  "K": round(S0 * 1.10, 2), "sigma": sigma, "label": "Long Call OTM"},
    ]

def _preset_iron_condor(S0, sigma):
    return [
        {"kind": "put",  "qty": 1,  "K": round(S0 * 0.85, 2), "sigma": sigma, "label": "Long Put far OTM"},
        {"kind": "put",  "qty": -1, "K": round(S0 * 0.95, 2), "sigma": sigma, "label": "Short Put OTM"},
        {"kind": "call", "qty": -1, "K": round(S0 * 1.05, 2), "sigma": sigma, "label": "Short Call OTM"},
        {"kind": "call", "qty": 1,  "K": round(S0 * 1.15, 2), "sigma": sigma, "label": "Long Call far OTM"},
    ]

def _preset_call_condor(S0, sigma):
    return [
        {"kind": "call", "qty": 1,  "K": round(S0 * 0.90, 2), "sigma": sigma, "label": "Long Call ITM"},
        {"kind": "call", "qty": -1, "K": round(S0 * 0.97, 2), "sigma": sigma, "label": "Short Call near-ITM"},
        {"kind": "call", "qty": -1, "K": round(S0 * 1.03, 2), "sigma": sigma, "label": "Short Call near-OTM"},
        {"kind": "call", "qty": 1,  "K": round(S0 * 1.10, 2), "sigma": sigma, "label": "Long Call OTM"},
    ]

def _preset_covered_call(S0, sigma):
    return [
        {"kind": "underlying", "qty": 1,  "premium": S0,                  "label": "Long Underlying"},
        {"kind": "call",       "qty": -1, "K": round(S0 * 1.05, 2), "sigma": sigma, "label": "Short Call OTM"},
    ]

def _preset_protective_put(S0, sigma):
    return [
        {"kind": "underlying", "qty": 1, "premium": S0,                   "label": "Long Underlying"},
        {"kind": "put",        "qty": 1, "K": round(S0 * 0.95, 2), "sigma": sigma, "label": "Long Put OTM"},
    ]

def _preset_collar(S0, sigma):
    return [
        {"kind": "underlying", "qty": 1,  "premium": S0,                  "label": "Long Underlying"},
        {"kind": "put",        "qty": 1,  "K": round(S0 * 0.95, 2), "sigma": sigma, "label": "Long Put OTM"},
        {"kind": "call",       "qty": -1, "K": round(S0 * 1.05, 2), "sigma": sigma, "label": "Short Call OTM"},
    ]

def _preset_synthetic_long(S0, sigma):
    return [
        {"kind": "call", "qty": 1,  "K": round(S0, 2), "sigma": sigma, "label": "Long Call ATM"},
        {"kind": "put",  "qty": -1, "K": round(S0, 2), "sigma": sigma, "label": "Short Put ATM"},
    ]

def _preset_synthetic_short(S0, sigma):
    return [
        {"kind": "call", "qty": -1, "K": round(S0, 2), "sigma": sigma, "label": "Short Call ATM"},
        {"kind": "put",  "qty": 1,  "K": round(S0, 2), "sigma": sigma, "label": "Long Put ATM"},
    ]

def _preset_risk_reversal(S0, sigma):
    return [
        {"kind": "call", "qty": 1,  "K": round(S0 * 1.05, 2), "sigma": sigma, "label": "Long Call OTM"},
        {"kind": "put",  "qty": -1, "K": round(S0 * 0.95, 2), "sigma": sigma, "label": "Short Put OTM"},
    ]


PRESETS: Dict[str, Dict[str, Any]] = {
    # category, label, view, builder
    "bull_call_spread":   {"cat": "directional", "label": "牛市看涨价差",  "view": "温和看涨,愿意限制最大盈利换取较低成本",                "builder": _preset_bull_call_spread},
    "bear_put_spread":    {"cat": "directional", "label": "熊市看跌价差",  "view": "温和看跌,限制下行收益换取低成本下注",                "builder": _preset_bear_put_spread},
    "bull_put_spread":    {"cat": "directional", "label": "牛市看跌价差",  "view": "看不跌,收期权金,以承担有限下行风险换取权利金",          "builder": _preset_bull_put_spread},
    "bear_call_spread":   {"cat": "directional", "label": "熊市看涨价差",  "view": "看不涨,收权利金,愿意承担有限上行风险",                  "builder": _preset_bear_call_spread},
    "long_straddle":      {"cat": "vol",         "label": "买入跨式",      "view": "预期波动率显著放大,方向不限",                            "builder": _preset_long_straddle},
    "short_straddle":     {"cat": "vol",         "label": "卖出跨式",      "view": "预期价格盘整、波动率回落,但需注意尾部风险",              "builder": _preset_short_straddle},
    "long_strangle":      {"cat": "vol",         "label": "买入宽跨式",    "view": "比跨式便宜,但需要更大幅度的方向突破",                    "builder": _preset_long_strangle},
    "short_strangle":     {"cat": "vol",         "label": "卖出宽跨式",    "view": "在更宽区间内收权利金,尾部风险仍然存在",                  "builder": _preset_short_strangle},
    "long_call_butterfly":{"cat": "neutral",     "label": "看涨蝶式",      "view": "预期到期标的精确落在中间行权价附近",                      "builder": _preset_long_call_butterfly},
    "long_put_butterfly": {"cat": "neutral",     "label": "看跌蝶式",      "view": "结构与看涨蝶式镜像,常用于流动性不同的合约",              "builder": _preset_long_put_butterfly},
    "iron_butterfly":     {"cat": "neutral",     "label": "铁蝶式",        "view": "卖出 ATM 跨式 + 买入两翼保护,有限风险中性策略",          "builder": _preset_iron_butterfly},
    "iron_condor":        {"cat": "neutral",     "label": "铁鹰式",        "view": "在更宽区间内收权利金 + 双向保护,经典区间套利",          "builder": _preset_iron_condor},
    "call_condor":        {"cat": "neutral",     "label": "看涨鹰式",      "view": "纯 call 构造的鹰式,中性,保证金占用更可控",              "builder": _preset_call_condor},
    "covered_call":       {"cat": "spot_combo",  "label": "备兑看涨",      "view": "持有现货收权利金,愿意以行权价上方放弃部分上行收益",      "builder": _preset_covered_call},
    "protective_put":     {"cat": "spot_combo",  "label": "保护性看跌",    "view": "持有现货 + 买入下行保险",                                "builder": _preset_protective_put},
    "collar":             {"cat": "spot_combo",  "label": "领口策略",      "view": "保护性看跌 + 备兑看涨,锁定区间收益",                      "builder": _preset_collar},
    "synthetic_long":     {"cat": "synthetic",   "label": "合成多头",      "view": "等价于持有现货,资金占用更低,但承担保证金风险",          "builder": _preset_synthetic_long},
    "synthetic_short":    {"cat": "synthetic",   "label": "合成空头",      "view": "等价于做空现货",                                          "builder": _preset_synthetic_short},
    "risk_reversal":      {"cat": "synthetic",   "label": "风险逆转",      "view": "卖出虚值看跌融资买入虚值看涨,常见于外汇市场",            "builder": _preset_risk_reversal},
}


def list_presets() -> List[Dict[str, str]]:
    return [{"key": k, "label": v["label"], "category": v["cat"], "view": v["view"]}
            for k, v in PRESETS.items()]


def build_preset(key: str, S0: float, sigma: float) -> List[Dict[str, Any]]:
    if key not in PRESETS:
        return []
    return PRESETS[key]["builder"](S0, sigma)
