"""HTML pages."""
from pathlib import Path
from fastapi import APIRouter, Request
from fastapi.templating import Jinja2Templates
from fastapi.responses import RedirectResponse

from .. import auth

TEMPLATES_DIR = Path(__file__).resolve().parent.parent.parent / "templates"
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

router = APIRouter()


@router.get("/")
def index(request: Request):
    """主页:游客可直接使用,登录态下额外解锁策略保存。"""
    user = auth.current_user(request)
    return templates.TemplateResponse("index.html", {"request": request, "user": user})


@router.get("/healthz")
def healthz():
    return {"ok": True}
