"""SQLite layer. WAL mode + foreign keys. Single connection-per-thread."""
import sqlite3
import threading
from contextlib import contextmanager
from .config import DB_PATH

_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    email        TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS strategies (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT,
    payload     TEXT NOT NULL,        -- JSON: legs + market params
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_strategies_user ON strategies(user_id, updated_at DESC);
"""


def _get_conn() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(str(DB_PATH), isolation_level=None, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        conn.execute("PRAGMA busy_timeout=5000;")
        _local.conn = conn
    return conn


def init_db():
    conn = _get_conn()
    conn.executescript(SCHEMA)


@contextmanager
def tx():
    """Explicit transaction; rolls back on exception."""
    conn = _get_conn()
    conn.execute("BEGIN")
    try:
        yield conn
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise


def query_one(sql: str, params: tuple = ()):
    return _get_conn().execute(sql, params).fetchone()


def query_all(sql: str, params: tuple = ()):
    return _get_conn().execute(sql, params).fetchall()


def execute(sql: str, params: tuple = ()) -> sqlite3.Cursor:
    return _get_conn().execute(sql, params)
