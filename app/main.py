"""FastAPI entry point."""
from pathlib import Path
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .db import init_db
from .routes.auth_routes import router as auth_router
from .routes.pricing_routes import router as pricing_router
from .routes.strategy_routes import router as strategy_router
from .routes.page_routes import router as page_router

app = FastAPI(title="Options Calculator", version="0.1.0", docs_url=None, redoc_url=None)

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.on_event("startup")
def _startup():
    init_db()


app.include_router(page_router)
app.include_router(auth_router)
app.include_router(pricing_router)
app.include_router(strategy_router)
