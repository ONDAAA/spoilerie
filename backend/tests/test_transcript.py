"""Tests for transcript chunking logic."""

from ml.transcript import TranscriptSegment, TranscriptChunk, chunk_transcript


def _seg(text: str, start: float, duration: float = 5.0) -> TranscriptSegment:
    return TranscriptSegment(text=text, start=start, duration=duration)


class TestChunkTranscript:
    def test_empty_segments(self):
        assert chunk_transcript([]) == []

    def test_single_segment(self):
        segments = [_seg("hello world", 0, 10)]
        chunks = chunk_transcript(segments, window_seconds=45, step_seconds=15)
        assert len(chunks) == 1
        assert chunks[0].text == "hello world"
        assert chunks[0].start == 0.0
        assert chunks[0].end == 10.0

    def test_overlapping_windows(self):
        """Segments at 0s, 10s, 20s, 30s with 30s window and 10s step should overlap."""
        segments = [
            _seg("intro", 0, 5),
            _seg("middle A", 10, 5),
            _seg("middle B", 20, 5),
            _seg("outro", 30, 5),
        ]
        chunks = chunk_transcript(segments, window_seconds=30, step_seconds=10)

        # First chunk (0-30s) should include intro, middle A, middle B
        assert "intro" in chunks[0].text
        assert "middle A" in chunks[0].text
        assert "middle B" in chunks[0].text

        # Second chunk (10-40s) should include middle A, middle B, outro
        assert "middle A" in chunks[1].text
        assert "outro" in chunks[1].text

    def test_chunk_timestamps_advance(self):
        segments = [_seg(f"seg{i}", i * 10, 5) for i in range(10)]
        chunks = chunk_transcript(segments, window_seconds=30, step_seconds=15)
        # Verify chunks advance in time
        for i in range(1, len(chunks)):
            assert chunks[i].start > chunks[i - 1].start

    def test_gap_in_segments(self):
        """Segments with gaps should still produce correct chunks."""
        segments = [
            _seg("early", 0, 5),
            _seg("late", 100, 5),
        ]
        chunks = chunk_transcript(segments, window_seconds=45, step_seconds=15)
        # First chunk gets "early", some chunks are empty (skipped), late chunk gets "late"
        assert any("early" in c.text for c in chunks)
        assert any("late" in c.text for c in chunks)

    def test_end_does_not_exceed_total(self):
        segments = [_seg("a", 0, 5), _seg("b", 50, 5)]
        chunks = chunk_transcript(segments, window_seconds=45, step_seconds=15)
        total = 55.0
        for chunk in chunks:
            assert chunk.end <= total
