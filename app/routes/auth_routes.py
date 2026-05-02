"""Auth routes: register / login / logout / me."""
from fastapi import APIRouter, Request, Response, HTTPException, Form, Depends
from fastapi.responses import JSONResponse, RedirectResponse

from .. import auth

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/register")
def register(response: Response,
             email: str = Form(...),
             password: str = Form(...),
             display_name: str = Form(None)):
    user_id = auth.create_user(email, password, display_name)
    auth.issue_session(response, user_id)
    return {"ok": True, "user": {"id": user_id, "email": email.strip().lower(),
                                  "display_name": display_name or email.strip().lower().split("@")[0]}}


@router.post("/login")
def login(response: Response, email: str = Form(...), password: str = Form(...)):
    user = auth.authenticate(email, password)
    if not user:
        raise HTTPException(401, "邮箱或密码错误")
    auth.issue_session(response, user["id"])
    return {"ok": True, "user": user}


@router.post("/logout")
def logout(response: Response):
    auth.clear_session(response)
    return {"ok": True}


@router.get("/me")
def me(request: Request):
    user = auth.current_user(request)
    if not user:
        return JSONResponse({"user": None})
    return {"user": user}
