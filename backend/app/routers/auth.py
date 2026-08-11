from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import auth
from ..database import get_db
from ..models import AuditLog, Organization, User
from ..schemas import LoginRequest, SignupRequest, TokenResponse, UserOut

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/signup", response_model=TokenResponse, status_code=201)
def signup(payload: SignupRequest, db: Session = Depends(get_db)):
    existing = db.scalar(select(User).where(User.email == payload.email.lower()))
    if existing is not None:
        raise HTTPException(status_code=409, detail="An account with that email already exists")

    org = Organization(name=payload.org_name)
    db.add(org)
    db.flush()

    user = User(
        org_id=org.id,
        email=payload.email.lower(),
        hashed_password=auth.hash_password(payload.password),
        full_name=payload.full_name,
    )
    db.add(user)
    db.flush()

    db.add(
        AuditLog(
            org_id=org.id,
            user_id=user.id,
            action="account_created",
            actor=user.email,
            details={"org_name": org.name},
        )
    )
    db.commit()

    return TokenResponse(access_token=auth.create_access_token(user.id))


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == payload.email.lower()))
    if user is None or not auth.verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Incorrect email or password")
    return TokenResponse(access_token=auth.create_access_token(user.id))


@router.get("/me", response_model=UserOut)
def me(current_user: User = Depends(auth.get_current_user)):
    return current_user
