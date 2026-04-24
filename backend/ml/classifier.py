"""
Core spoiler classification logic.

For each comment:
1. Find the transcript chunk most similar to the comment (cosine similarity)
2. The chunk's midpoint timestamp is the "estimated reference timestamp"
3. If estimated_timestamp > current_time → spoiler
"""

from dataclasses import dataclass
from typing import Optional
import numpy as np

from .transcript import TranscriptChunk
from .embedder import embed, cosine_similarity_matrix

MIN_CONFIDENCE = 0.35


@dataclass
class ClassificationResult:
    comment_id: str
    estimated_timestamp: Optional[float]
    is_spoiler: bool
    confidence: float


def classify_comments(
    comments: list[tuple[str, str]],   # (id, text)
    chunks: list[TranscriptChunk],
    current_time: float,
    video_duration: float,
    chunk_embeddings: Optional[np.ndarray] = None,
) -> list[ClassificationResult]:
    if not chunks or not comments:
        return [
            ClassificationResult(id, None, False, 0.0)
            for id, _ in comments
        ]

    # Only embed comments — chunk embeddings are cached
    comment_texts = [text for _, text in comments]
    comment_embs = embed(comment_texts)  # (N, D) — this is fast (few comments)

    if chunk_embeddings is None:
        chunk_texts = [c.text for c in chunks]
        chunk_embeddings = embed(chunk_texts)  # (M, D) — slow, but only if not cached

    sim_matrix = cosine_similarity_matrix(comment_embs, chunk_embeddings)  # (N, M)

    results = []
    for i, (comment_id, _) in enumerate(comments):
        best_chunk_idx = int(np.argmax(sim_matrix[i]))
        confidence = float(sim_matrix[i, best_chunk_idx])
        best_chunk = chunks[best_chunk_idx]
        estimated_ts = (best_chunk.start + best_chunk.end) / 2

        if confidence < MIN_CONFIDENCE:
            results.append(ClassificationResult(comment_id, None, False, confidence))
            continue

        is_spoiler = estimated_ts > current_time
        results.append(ClassificationResult(comment_id, estimated_ts, is_spoiler, confidence))

    return results
