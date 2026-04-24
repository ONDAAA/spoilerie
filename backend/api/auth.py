"""Authentication middleware — Supabase JWT verification + API key lookup."""

import os
import logging
from typing import Optional

import jwt
from fastapi import Request, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)

SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")

# Tiers
TIER_FREE = "free"
TIER_PRO = "pro"


class User(BaseModel):
    id: str
    email: Optional[str] = None
    tier: str = TIER_FREE


async def get_current_user(request: Request) -> Optional[User]:
    """
    Extract user from request. Supports:
    1. Supabase JWT in Authorization header (from Chrome extension)
    2. API key in X-API-Key header (for programmatic access)
    3. Anonymous (returns None)
    """
    # Try JWT first
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
        return _verify_jwt(token)

    # Try API key
    api_key = request.headers.get("X-API-Key")
    if api_key:
        return await _lookup_api_key(api_key)

    # Anonymous
    return None


def _verify_jwt(token: str) -> Optional[User]:
    """Verify Supabase JWT and extract user info."""
    if not SUPABASE_JWT_SECRET:
        logger.warning("SUPABASE_JWT_SECRET not set — skipping JWT verification")
        return None

    try:
        payload = jwt.decode(
            token,
            SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            audience="authenticated",
        )
        return User(
            id=payload.get("sub", ""),
            email=payload.get("email"),
            tier=payload.get("user_metadata", {}).get("tier", TIER_FREE),
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError as e:
        logger.warning("Invalid JWT: %s", e)
        raise HTTPException(status_code=401, detail="Invalid token")


async def _lookup_api_key(api_key: str) -> Optional[User]:
    """
    Look up API key in database.
    TODO: implement Supabase lookup when DB is set up.
    For now, accept any key and treat as free tier.
    """
    if not api_key or len(api_key) < 16:
        raise HTTPException(status_code=401, detail="Invalid API key")

    # Placeholder — will be replaced with Supabase query
    return User(id=f"apikey:{api_key[:8]}", tier=TIER_FREE)
