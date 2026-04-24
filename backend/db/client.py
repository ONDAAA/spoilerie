"""Supabase client singleton."""

import os
import logging
from functools import lru_cache
from typing import Optional

logger = logging.getLogger(__name__)

_client = None


def get_supabase():
    """Get Supabase client. Returns None if not configured."""
    global _client
    if _client is not None:
        return _client

    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_KEY")

    if not url or not key:
        logger.warning("SUPABASE_URL or SUPABASE_KEY not set — running without database")
        return None

    try:
        from supabase import create_client
        _client = create_client(url, key)
        logger.info("Supabase client initialized")
        return _client
    except Exception as e:
        logger.error("Failed to initialize Supabase: %s", e)
        return None
