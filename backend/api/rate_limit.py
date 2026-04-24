"""Rate limiting middleware using slowapi."""

import os
from slowapi import Limiter
from slowapi.util import get_remote_address
from starlette.requests import Request

# Keyed by IP for anonymous users, by API key for authenticated
def _key_func(request: Request) -> str:
    api_key = request.headers.get("X-API-Key")
    if api_key:
        return f"key:{api_key}"
    return get_remote_address(request)


limiter = Limiter(key_func=_key_func)

# Tier limits (requests per minute)
FREE_LIMIT = os.getenv("RATE_LIMIT_FREE", "10/minute")
PRO_LIMIT = os.getenv("RATE_LIMIT_PRO", "60/minute")
