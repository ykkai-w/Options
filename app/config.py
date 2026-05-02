"""Centralised config; reads from env with safe defaults."""
import os
import secrets
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)

DB_PATH = DATA_DIR / "options.db"

# Session signing key. In production set OPTIONS_SECRET_KEY in .env;
# fall back to a generated key written to disk so restarts don't invalidate sessions.
_KEY_FILE = DATA_DIR / ".session_key"
def _load_secret_key() -> str:
    env_key = os.environ.get("OPTIONS_SECRET_KEY")
    if env_key:
        return env_key
    if _KEY_FILE.exists():
        return _KEY_FILE.read_text().strip()
    new_key = secrets.token_urlsafe(48)
    _KEY_FILE.write_text(new_key)
    _KEY_FILE.chmod(0o600)
    return new_key

SECRET_KEY = _load_secret_key()
SESSION_COOKIE = "opt_sid"
SESSION_MAX_AGE = 60 * 60 * 24 * 30  # 30 days

# Operational
DEBUG = os.environ.get("OPTIONS_DEBUG", "0") == "1"
