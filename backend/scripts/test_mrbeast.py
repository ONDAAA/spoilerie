"""Test spoiler detection on MrBeast videos with real comments."""

import asyncio
import json
import re
import httpx
from youtube_transcript_api import YouTubeTranscriptApi

VIDEO_IDS = [
    "zRtGL0-5rg4",
    "DXVHmGoCTco",
    "JFtlf8RoPZY",
    "AoN1K4c7VKE",
    "5OLs1GWB4OA",
]

API_URL = "http://127.0.0.1:8000/analyze"
_yt_api = YouTubeTranscriptApi()


def get_video_title(html: str) -> str:
    m = re.search(r'"title":\{"runs":\[\{"text":"(.+?)"\}', html)
    return m.group(1) if m else "Unknown"


def get_video_duration(html: str) -> float:
    m = re.search(r'"lengthSeconds":"(\d+)"', html)
    return float(m.group(1)) if m else 600.0


def scrape_comments(html: str, limit: int = 15) -> list[dict]:
    """
    YouTube doesn't render comments in initial HTML (they're lazy loaded).
    We'll extract from ytInitialData instead — top comments from engagement panels.
    Fallback: use hardcoded sample approach via continuation token.
    """
    # Comments aren't in initial HTML. Let's pull from the API using continuation.
    # For testing purposes, we'll extract any text that looks like comments from the page.
    # In production the Chrome extension scrapes them from the live DOM.
    return []


async def fetch_real_comments(video_id: str) -> list[dict]:
    """Use innertube API to fetch actual comments."""
    async with httpx.AsyncClient(timeout=15) as client:
        # First get the continuation token from the video page
        resp = await client.get(
            f"https://www.youtube.com/watch?v={video_id}",
            headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
                "Accept-Language": "en-US,en;q=0.9",
            },
        )
        html = resp.text

        # Find comment section continuation token
        m = re.search(r'"continuationCommand":\{"token":"(Eg[A-Za-z0-9_-]+)".*?"label":".*?comment', html)
        if not m:
            # Try alternative pattern
            tokens = re.findall(r'"token":"(Eg[A-Za-z0-9_-]{20,})"', html)
            if not tokens:
                return []
            token = tokens[-1]  # Usually the last Eg* token is for comments
        else:
            token = m.group(1)

        # Fetch comments via innertube
        payload = {
            "context": {
                "client": {
                    "clientName": "WEB",
                    "clientVersion": "2.20240101.00.00",
                }
            },
            "continuation": token,
        }
        resp = await client.post(
            "https://www.youtube.com/youtubei/v1/next?prettyPrint=false",
            json=payload,
            headers={"Content-Type": "application/json"},
        )
        data = resp.json()

        comments = []
        # Navigate the deeply nested structure
        def extract_comments(obj):
            if isinstance(obj, dict):
                if "contentText" in obj and "runs" in obj.get("contentText", {}):
                    text = "".join(r.get("text", "") for r in obj["contentText"]["runs"])
                    if text.strip() and len(text.strip()) > 5:
                        comments.append(text.strip())
                for v in obj.values():
                    extract_comments(v)
            elif isinstance(obj, list):
                for item in obj:
                    extract_comments(item)

        extract_comments(data)
        return comments[:15]


async def test_video(video_id: str):
    print(f"\n{'='*70}")
    print(f"VIDEO: https://youtube.com/watch?v={video_id}")

    # Get title and duration
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"https://www.youtube.com/watch?v={video_id}",
            headers={
                "User-Agent": "Mozilla/5.0",
                "Accept-Language": "en-US,en;q=0.9",
            },
        )
        title = get_video_title(resp.text)
        duration = get_video_duration(resp.text)

    print(f"TITLE: {title}")
    print(f"DURATION: {duration:.0f}s ({duration/60:.1f}min)")

    # Check transcript
    try:
        transcript = _yt_api.fetch(video_id, languages=["en"])
        segments = list(transcript)
        print(f"TRANSCRIPT: {len(segments)} segments")
    except Exception as e:
        print(f"TRANSCRIPT: unavailable ({e})")
        return

    # Fetch real comments
    comments = await fetch_real_comments(video_id)
    if not comments:
        print("COMMENTS: could not fetch (YouTube anti-bot)")
        # Use simulated comments based on typical MrBeast video patterns
        comments = [
            "The ending was insane I did not expect that",
            "Bro the twist at the end had me shook",
            "First challenge was already crazy",
            "Great video as always",
            "Who else is watching this in 2024",
            "The part where he gives away the money was so wholesome",
            "I cant believe what happened to the last person",
            "The beginning was slow but it got so good",
            "This is his best video yet",
            "That elimination round was brutal",
        ]
        print(f"COMMENTS: using 10 simulated MrBeast-style comments")
    else:
        print(f"COMMENTS: {len(comments)} real comments fetched")

    # Simulate user at 25% through the video
    current_time = duration * 0.25
    print(f"SIMULATED POSITION: {current_time:.0f}s ({current_time/60:.1f}min) = 25% through")
    print()

    # Call our API
    payload = {
        "videoId": video_id,
        "currentTime": current_time,
        "videoDuration": duration,
        "comments": [
            {"id": f"c{i}", "text": c} for i, c in enumerate(comments)
        ],
    }

    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(API_URL, json=payload)
        result = resp.json()

    if not result["transcriptAvailable"]:
        print("  Transcript not available via API")
        return

    print(f"{'COMMENT':<55} {'TIMESTAMP':>10} {'SPOILER':>8} {'CONF':>6}")
    print("-" * 85)

    spoiler_count = 0
    for r, text in zip(result["results"], comments):
        ts = r["estimatedTimestamp"]
        ts_str = f"{ts/60:.1f}min" if ts else "N/A"
        spoiler = "SPOILER" if r["isSpoiler"] and r["confidence"] > 0.6 else ""
        if spoiler:
            spoiler_count += 1
        conf = f"{r['confidence']:.2f}"
        display = text[:52] + "..." if len(text) > 55 else text
        print(f"{display:<55} {ts_str:>10} {spoiler:>8} {conf:>6}")

    print(f"\n  => {spoiler_count} comments would be hidden as spoilers")


async def main():
    print("SPOILERIE — MrBeast Channel Test")
    print("Testing spoiler detection on real videos\n")

    for vid in VIDEO_IDS:
        try:
            await test_video(vid)
        except Exception as e:
            print(f"\n  ERROR on {vid}: {e}")

    print(f"\n{'='*70}")
    print("DONE")


if __name__ == "__main__":
    asyncio.run(main())
