"""Singleton embedding model + cosine similarity helpers."""

import os
import numpy as np
from sentence_transformers import SentenceTransformer
from functools import lru_cache

MODEL_NAME = os.getenv("MODEL_NAME", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")


@lru_cache(maxsize=1)
def get_model() -> SentenceTransformer:
    return SentenceTransformer(MODEL_NAME)


def embed(texts: list[str]) -> np.ndarray:
    model = get_model()
    return model.encode(texts, normalize_embeddings=True, show_progress_bar=False)


def cosine_similarity_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """
    a: (N, D), b: (M, D) — both L2-normalized
    returns: (N, M) similarity matrix
    """
    return a @ b.T
