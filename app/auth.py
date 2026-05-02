"""Authentication: bcrypt password hashing + signed cookie sessions."""
import re
import bcrypt
from typing import Optional
from datetime import datetime, timezone
from fastapi import Request, Response, HTTPException, status
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

from . import db
from .config import SECRET_KEY, SESSION_COOKIE, SESSION_MAX_AGE

serializer = URLSafeTimedSerializer(SECRET_KEY, salt="options-calc-session-v1")

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MIN_PASSWORD_LEN = 8
BCRYPT_MAX_BYTES = 72  # bcrypt only uses first 72 bytes; we pre-truncate for predictable behaviour


def _to_bytes(plain: str) -> bytes:
    b = plain.encode("utf-8")
    return b[:BCRYPT_MAX_BYTES]


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(_to_bytes(plain), bcrypt.gensalt(rounds=12)).decode("ascii")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(_to_bytes(plain), hashed.encode("ascii"))
    except (ValueError, TypeError):
        return False


def validate_email(email: str) -> bool:
    return bool(EMAIL_RE.match(email)) and len(email) <= 254


def validate_password(password: str) -> Optional[str]:
    if len(password) < MIN_PASSWORD_LEN:
        return f"密码至少 {MIN_PASSWORD_LEN} 位"
    if len(password) > 128:
        return "密码过长(超过 128 位)"
    return None


def create_user(email: str, password: str, display_name: str = None) -> int:
    email = email.strip().lower()
    if not validate_email(email):
        raise HTTPException(400, "邮箱格式不正确")
    err = validate_password(password)
    if err:
        raise HTTPException(400, err)
    existing = db.query_one("SELECT id FROM users WHERE email = ?", (email,))
    if existing:
        raise HTTPException(409, "该邮箱已注册")
    cur = db.execute(
        "INSERT INTO users(email, password_hash, display_name) VALUES (?, ?, ?)",
        (email, hash_password(password), display_name or email.split("@")[0]),
    )
    return cur.lastrowid


def authenticate(email: str, password: str):
    email = email.strip().lower()
    row = db.query_one(
        "SELECT id, email, password_hash, display_name FROM users WHERE email = ?",
        (email,),
    )
    if not row or not verify_password(password, row["password_hash"]):
        return None
    db.execute(
        "UPDATE users SET last_login_at = ? WHERE id = ?",
        (datetime.now(timezone.utc).isoformat(timespec="seconds"), row["id"]),
    )
    return {"id": row["id"], "email": row["email"], "display_name": row["display_name"]}


def issue_session(response: Response, user_id: int):
    token = serializer.dumps({"uid": user_id})
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        max_age=SESSION_MAX_AGE,
        httponly=True,
        secure=True,
        samesite="lax",
        path="/",
    )


def clear_session(response: Response):
    response.delete_cookie(SESSION_COOKIE, path="/")


def _decode(token: str) -> Optional[int]:
    try:
        data = serializer.loads(token, max_age=SESSION_MAX_AGE)
        uid = data.get("uid")
        return int(uid) if uid is not None else None
    except (BadSignature, SignatureExpired, ValueError):
        return None


def current_user(request: Request) -> Optional[dict]:
    """Returns user dict or None. Use as dependency for optional auth."""
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    uid = _decode(token)
    if uid is None:
        return None
    row = db.query_one(
        "SELECT id, email, display_name FROM users WHERE id = ?", (uid,)
    )
    if not row:
        return None
    return {"id": row["id"], "email": row["email"], "display_name": row["display_name"]}


def require_user(request: Request) -> dict:
    """Dependency that 401s if not logged in."""
    user = current_user(request)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="请先登录")
    return user
