"""Strategy persistence: save / list / load / delete user strategies."""
import json
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from .. import db
from ..auth import require_user
from ..strategies import StrategyPayload

router = APIRouter(prefix="/api/strategies", tags=["strategies"])


class SaveIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    description: str | None = Field(None, max_length=600)
    payload: StrategyPayload


@router.get("/")
def list_my_strategies(user=Depends(require_user)):
    rows = db.query_all(
        "SELECT id, name, description, created_at, updated_at "
        "FROM strategies WHERE user_id = ? ORDER BY updated_at DESC",
        (user["id"],),
    )
    return {"strategies": [dict(r) for r in rows]}


@router.post("/")
def create_strategy(body: SaveIn, user=Depends(require_user)):
    cur = db.execute(
        "INSERT INTO strategies(user_id, name, description, payload) VALUES (?, ?, ?, ?)",
        (user["id"], body.name, body.description, body.payload.model_dump_json()),
    )
    return {"id": cur.lastrowid}


@router.get("/{sid}")
def get_strategy(sid: int, user=Depends(require_user)):
    row = db.query_one(
        "SELECT id, name, description, payload, created_at, updated_at "
        "FROM strategies WHERE id = ? AND user_id = ?",
        (sid, user["id"]),
    )
    if not row:
        raise HTTPException(404, "策略不存在")
    out = dict(row)
    out["payload"] = json.loads(out["payload"])
    return out


@router.put("/{sid}")
def update_strategy(sid: int, body: SaveIn, user=Depends(require_user)):
    row = db.query_one(
        "SELECT id FROM strategies WHERE id = ? AND user_id = ?",
        (sid, user["id"]),
    )
    if not row:
        raise HTTPException(404, "策略不存在")
    db.execute(
        "UPDATE strategies SET name=?, description=?, payload=?, updated_at=? WHERE id=?",
        (body.name, body.description, body.payload.model_dump_json(),
         datetime.now(timezone.utc).isoformat(timespec="seconds"), sid),
    )
    return {"ok": True}


@router.delete("/{sid}")
def delete_strategy(sid: int, user=Depends(require_user)):
    row = db.query_one(
        "SELECT id FROM strategies WHERE id = ? AND user_id = ?",
        (sid, user["id"]),
    )
    if not row:
        raise HTTPException(404, "策略不存在")
    db.execute("DELETE FROM strategies WHERE id = ?", (sid,))
    return {"ok": True}
