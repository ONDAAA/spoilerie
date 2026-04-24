"""Tests for the /analyze API endpoint."""

import pytest
from unittest.mock import patch, AsyncMock
from fastapi.testclient import TestClient

from api.main import app
from ml.transcript import TranscriptSegment, TranscriptChunk


@pytest.fixture
def client():
    return TestClient(app)


class TestHealthEndpoint:
    def test_health(self, client: TestClient):
        resp = client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] in ("ok", "degraded")


class TestAnalyzeEndpoint:
    def test_empty_comments_returns_400(self, client: TestClient):
        resp = client.post("/analyze", json={
            "videoId": "abc123",
            "currentTime": 0,
            "videoDuration": 100,
            "comments": [],
        })
        assert resp.status_code == 400

    @patch("api.routes.analyze.get_chunks")
    def test_no_transcript(self, mock_chunks, client: TestClient):
        mock_chunks.return_value = None
        resp = client.post("/analyze", json={
            "videoId": "abc123",
            "currentTime": 30,
            "videoDuration": 300,
            "comments": [{"id": "c1", "text": "great video this is awesome"}],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["transcriptAvailable"] is False
        assert len(data["results"]) == 1
        assert data["results"][0]["isSpoiler"] is False

    @patch("api.routes.analyze.get_chunks")
    def test_with_transcript(self, mock_chunks, client: TestClient):
        mock_chunks.return_value = [
            TranscriptChunk(text="welcome to the show", start=0, end=30),
            TranscriptChunk(text="the surprise ending was incredible", start=200, end=250),
        ]
        resp = client.post("/analyze", json={
            "videoId": "abc123",
            "currentTime": 30,
            "videoDuration": 300,
            "comments": [
                {"id": "c1", "text": "welcome to the show great start"},
                {"id": "c2", "text": "the surprise ending was incredible I did not expect it"},
            ],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["transcriptAvailable"] is True
        assert len(data["results"]) == 2
        # Both results should have confidence > 0
        for r in data["results"]:
            assert "commentId" in r
            assert "isSpoiler" in r
            assert "confidence" in r

    def test_invalid_video_id(self, client: TestClient):
        """Missing required fields should return 422."""
        resp = client.post("/analyze", json={
            "currentTime": 30,
            "comments": [{"id": "c1", "text": "hello world test comment"}],
        })
        assert resp.status_code == 422
