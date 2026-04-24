"""
Bootstrap training data from YouTube comments that explicitly mention timestamps.
Pattern: "at 4:32", "4:32", "at minute 12", "@4:32", etc.

Usage:
  python training/scripts/collect_data.py --video-ids ids.txt --out data/labeled.jsonl
"""

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))

import httpx
from ml.transcript import fetch_transcript, chunk_transcript

TIMESTAMP_RE = re.compile(
    r"(?:^|[\s@(])(\d{1,2}):(\d{2})(?::(\d{2}))?(?=[\s,.)!?]|$)", re.MULTILINE
)


def parse_timestamp(m: re.Match) -> float:
    h = 0
    if m.group(3):
        h, mins, secs = int(m.group(1)), int(m.group(2)), int(m.group(3))
    else:
        h, mins, secs = 0, int(m.group(1)), int(m.group(2))
    return h * 3600 + mins * 60 + secs


async def get_comments(video_id: str, api_key: str, max_results: int = 500) -> list[dict]:
    """Fetch top comments via YouTube Data API v3."""
    url = "https://www.googleapis.com/youtube/v3/commentThreads"
    params = {
        "part": "snippet",
        "videoId": video_id,
        "maxResults": min(max_results, 100),
        "order": "relevance",
        "key": api_key,
    }
    comments = []
    async with httpx.AsyncClient(timeout=15) as client:
        while len(comments) < max_results:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
            for item in data.get("items", []):
                snippet = item["snippet"]["topLevelComment"]["snippet"]
                comments.append({
                    "id": item["id"],
                    "text": snippet["textOriginal"],
                    "likeCount": snippet["likeCount"],
                })
            next_page = data.get("nextPageToken")
            if not next_page or len(comments) >= max_results:
                break
            params["pageToken"] = next_page
    return comments


async def process_video(video_id: str, api_key: str, out_file: Path):
    print(f"Processing {video_id}...")

    segments = await fetch_transcript(video_id)
    if not segments:
        print(f"  No transcript — skipping")
        return 0

    chunks = chunk_transcript(segments)
    duration = segments[-1].start + segments[-1].duration

    comments = await get_comments(video_id, api_key)
    labeled = 0

    with out_file.open("a") as f:
        for comment in comments:
            matches = list(TIMESTAMP_RE.finditer(comment["text"]))
            if not matches:
                continue
            # Use first timestamp mention as the ground truth label
            ts = parse_timestamp(matches[0])
            if ts > duration:
                continue
            record = {
                "video_id": video_id,
                "comment_id": comment["id"],
                "text": comment["text"],
                "timestamp": ts,
                "timestamp_normalized": ts / duration,
                "like_count": comment["likeCount"],
            }
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
            labeled += 1

    print(f"  Labeled {labeled}/{len(comments)} comments")
    return labeled


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video-ids", required=True, help="File with one video ID per line")
    parser.add_argument("--api-key", required=True, help="YouTube Data API v3 key")
    parser.add_argument("--out", default="training/data/labeled.jsonl")
    args = parser.parse_args()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    video_ids = Path(args.video_ids).read_text().splitlines()
    video_ids = [v.strip() for v in video_ids if v.strip()]

    total = 0
    for vid in video_ids:
        total += await process_video(vid, args.api_key, out)

    print(f"\nTotal labeled records: {total}")
    print(f"Saved to: {out}")


if __name__ == "__main__":
    asyncio.run(main())
