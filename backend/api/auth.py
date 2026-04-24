"""Authentication — Supabase JWT + API key lookup with usage tracking."""

import hashlib
import logging
import os
from typing import Optional

import jwt
from fastapi import HTTPException, Request
from pydantic import BaseModel

from db.client import get_supabase

logger = logging.getLogger(__name__)

SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")

TIER_FREE = "free"
TIER_PRO = "pro"
FREE_DAILY_LIMIT = 10


class User(BaseModel):
    id: str
    email: Optional[str] = None
    tier: str = TIER_FREE


async def get_current_user(request: Request) -> Optional[User]:
    """
    Extract user from request:
    1. Supabase JWT in Authorization header
    2. API key in X-API-Key header
    3. Anonymous (None)
    """
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        return _verify_jwt(auth_header[7:])

    api_key = request.headers.get("X-API-Key")
    if api_key:
        return await _lookup_api_key(api_key)

    return None


async def check_usage_limit(user: Optional[User]) -> None:
    """
    Check if user has exceeded daily free tier limit.
    Pro users and anonymous users (rate-limited by IP) skip this.
    """
    if user is None:
        return  # anonymous — handled by IP rate limiter
    if user.tier == TIER_PRO:
        return

    sb = get_supabase()
    if not sb:
        return  # no DB — no limit enforcement

    try:
        result = sb.rpc("increment_usage", {"p_user_id": user.id}).execute()
        count = result.data
        if isinstance(count, int) and count > FREE_DAILY_LIMIT:
            raise HTTPException(
                status_code=429,
                detail=f"Free tier limit reached ({FREE_DAILY_LIMIT} videos/day). Upgrade to Pro for unlimited access.",
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("Usage check failed: %s", e)


async def log_usage(
    user: Optional[User],
    video_id: str,
    comments_count: int,
    spoilers_found: int,
    processing_ms: int,
) -> None:
    """Log usage to Supabase for analytics."""
    sb = get_supabase()
    if not sb:
        return

    try:
        sb.table("usage_log").insert({
            "user_id": user.id if user else None,
            "video_id": video_id,
            "comments_count": comments_count,
            "spoilers_found": spoilers_found,
            "processing_ms": processing_ms,
        }).execute()
    except Exception as e:
        logger.warning("Usage logging failed: %s", e)


def _verify_jwt(token: str) -> Optional[User]:
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
        user_id = payload.get("sub", "")

        # Try to get tier from DB
        tier = TIER_FREE
        sb = get_supabase()
        if sb:
            try:
                result = sb.table("profiles").select("tier").eq("id", user_id).single().execute()
                if result.data:
                    tier = result.data.get("tier", TIER_FREE)
            except Exception:
                pass

        return User(id=user_id, email=payload.get("email"), tier=tier)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError as e:
        logger.warning("Invalid JWT: %s", e)
        raise HTTPException(status_code=401, detail="Invalid token")


async def _lookup_api_key(api_key: str) -> Optional[User]:
    if not api_key or len(api_key) < 16:
        raise HTTPException(status_code=401, detail="Invalid API key")

    sb = get_supabase()
    if not sb:
        # No DB — accept key but treat as free
        return User(id=f"apikey:{api_key[:8]}", tier=TIER_FREE)

    key_hash = hashlib.sha256(api_key.encode()).hexdigest()

    try:
        result = (
            sb.table("api_keys")
            .select("user_id, is_active, profiles(tier)")
            .eq("key_hash", key_hash)
            .single()
            .execute()
        )

        if not result.data:
            raise HTTPException(status_code=401, detail="Unknown API key")

        if not result.data.get("is_active"):
            raise HTTPException(status_code=401, detail="API key deactivated")

        # Update last_used_at
        sb.table("api_keys").update({"last_used_at": "now()"}).eq("key_hash", key_hash).execute()

        tier = result.data.get("profiles", {}).get("tier", TIER_FREE)
        return User(id=result.data["user_id"], tier=tier)
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("API key lookup failed: %s", e)
        return User(id=f"apikey:{api_key[:8]}", tier=TIER_FREE)
