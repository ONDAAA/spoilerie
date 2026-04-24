import logging
import os

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

from .rate_limit import limiter
from .routes import analyze

app = FastAPI(title="Spoilerie API", version="0.1.0")

# Rate limiter
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS
cors_origins = os.getenv("CORS_ORIGINS", "http://localhost:3000")
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins.split(","),
    allow_methods=["POST", "GET"],
    allow_headers=["Content-Type", "Authorization", "X-API-Key"],
)

app.include_router(analyze.router)


@app.get("/health")
def health():
    from ml.embedder import get_model
    try:
        get_model()
        model_ok = True
    except Exception:
        model_ok = False
    return {"status": "ok" if model_ok else "degraded", "model_loaded": model_ok}
