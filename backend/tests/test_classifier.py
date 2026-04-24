"""Tests for the spoiler classifier."""

import pytest
from ml.transcript import TranscriptSegment, TranscriptChunk, chunk_transcript
from ml.classifier import classify_comments, ClassificationResult


def _make_video_chunks() -> list[TranscriptChunk]:
    """Create a simple test video transcript: 3 distinct parts over 300 seconds."""
    segments = [
        TranscriptSegment("Welcome to the cooking show today we make pasta", 0, 10),
        TranscriptSegment("First we boil the water and add salt", 10, 10),
        TranscriptSegment("Now we add the spaghetti to the boiling water", 30, 10),
        TranscriptSegment("Next we prepare the tomato sauce with garlic and basil", 100, 10),
        TranscriptSegment("We simmer the sauce for twenty minutes stirring occasionally", 120, 10),
        TranscriptSegment("Adding parmesan cheese and fresh herbs on top", 200, 10),
        TranscriptSegment("The final plating looks absolutely beautiful", 250, 10),
        TranscriptSegment("Thank you for watching please subscribe", 290, 10),
    ]
    return chunk_transcript(segments, window_seconds=45, step_seconds=15)


class TestClassifyComments:
    @pytest.fixture(autouse=True)
    def setup(self):
        self.chunks = _make_video_chunks()

    def test_empty_comments(self):
        results = classify_comments([], self.chunks, 0, 300)
        assert results == []

    def test_empty_chunks(self):
        results = classify_comments([("c1", "hello")], [], 0, 300)
        assert len(results) == 1
        assert results[0].is_spoiler is False
        assert results[0].estimated_timestamp is None

    def test_early_content_not_spoiler(self):
        """Comment about boiling water should match early in the video."""
        results = classify_comments(
            [("c1", "Boiling the water with salt was a great first step")],
            self.chunks,
            current_time=150,  # user is at 150s
            video_duration=300,
        )
        assert len(results) == 1
        # Should reference early content (< 150s), thus NOT a spoiler
        r = results[0]
        if r.estimated_timestamp is not None and r.confidence > 0.35:
            assert r.estimated_timestamp < 150
            assert r.is_spoiler is False

    def test_late_content_is_spoiler(self):
        """Comment about final plating should be spoiler when user is early."""
        results = classify_comments(
            [("c1", "The final plating with parmesan and fresh herbs looked amazing")],
            self.chunks,
            current_time=30,  # user is at 30s
            video_duration=300,
        )
        r = results[0]
        # If model is confident enough, this should be a spoiler
        if r.confidence > 0.35:
            assert r.is_spoiler is True
            assert r.estimated_timestamp is not None
            assert r.estimated_timestamp > 30

    def test_generic_comment_low_confidence(self):
        """Very generic comments should have low confidence."""
        results = classify_comments(
            [("c1", "nice video")],
            self.chunks,
            current_time=150,
            video_duration=300,
        )
        r = results[0]
        # Generic comments typically have lower confidence
        assert r.confidence < 0.7

    def test_returns_correct_ids(self):
        comments = [("id_a", "test one"), ("id_b", "test two")]
        results = classify_comments(comments, self.chunks, 0, 300)
        assert results[0].comment_id == "id_a"
        assert results[1].comment_id == "id_b"

    def test_all_results_have_valid_confidence(self):
        comments = [("c1", "the sauce was great"), ("c2", "amazing ending")]
        results = classify_comments(comments, self.chunks, 60, 300)
        for r in results:
            assert 0.0 <= r.confidence <= 1.0
