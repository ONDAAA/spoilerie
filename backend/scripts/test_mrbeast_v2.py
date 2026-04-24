"""
Test spoiler detection on MrBeast videos.

Since YouTube blocks server-side comment fetching, we:
1. Read the actual transcript of each video
2. Create comments that reference SPECIFIC content from different parts
3. Test whether the classifier correctly identifies which parts they spoil
"""

import asyncio
import httpx
from youtube_transcript_api import YouTubeTranscriptApi
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ml.transcript import TranscriptSegment, chunk_transcript
from ml.classifier import classify_comments

_api = YouTubeTranscriptApi()
API_URL = "http://127.0.0.1:8000/analyze"


async def get_title_duration(video_id: str) -> tuple[str, float]:
    import re
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"https://www.youtube.com/watch?v={video_id}",
            headers={"User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en;q=0.9"},
        )
        title_m = re.search(r'"title":\{"runs":\[\{"text":"(.+?)"\}', resp.text)
        dur_m = re.search(r'"lengthSeconds":"(\d+)"', resp.text)
        title = title_m.group(1) if title_m else "Unknown"
        dur = float(dur_m.group(1)) if dur_m else 600.0
    return title, dur


def get_transcript_excerpts(video_id: str) -> list[tuple[float, str]]:
    """Return (timestamp, text_excerpt) for key moments in the video."""
    try:
        fetched = _api.fetch(video_id, languages=["en"])
    except Exception:
        return []

    segments = [
        TranscriptSegment(text=s.text.strip(), start=s.start, duration=s.duration)
        for s in fetched if s.text.strip()
    ]
    if not segments:
        return []

    total = segments[-1].start + segments[-1].duration
    # Sample at 10%, 25%, 50%, 75%, 90%
    targets = [0.10, 0.25, 0.50, 0.75, 0.90]
    excerpts = []
    for pct in targets:
        t = total * pct
        nearby = [s for s in segments if abs(s.start - t) < 30]
        if nearby:
            text = " ".join(s.text for s in nearby[:5])
            excerpts.append((t, text[:200]))
    return excerpts


async def test_video(video_id: str):
    title, duration = await get_title_duration(video_id)
    print(f"\n{'='*80}")
    print(f"VIDEO: {title}")
    print(f"URL: https://youtube.com/watch?v={video_id}")
    print(f"DURATION: {duration:.0f}s ({duration/60:.1f}min)")

    excerpts = get_transcript_excerpts(video_id)
    if not excerpts:
        print("  No transcript available — skipping")
        return

    print(f"\nTRANSCRIPT EXCERPTS (used to craft test comments):")
    for ts, text in excerpts:
        print(f"  [{ts/60:.1f}min] {text[:100]}...")

    # Create comments that reference specific parts of the video
    comments = []

    # Generic comments (should NOT be spoilers)
    comments.append(("generic_1", "This video is amazing love MrBeast"))
    comments.append(("generic_2", "First"))
    comments.append(("generic_3", "Who is watching this right now"))

    # Comments referencing early content (before 25% = NOT spoilers)
    if len(excerpts) >= 1:
        early = excerpts[0][1][:60]
        comments.append(("early_ref", f"The part about {early.lower().split()[-3:]} at the start was great"))

    # Comments referencing mid content (after 25% = SPOILERS)
    if len(excerpts) >= 3:
        mid_text = excerpts[2][1]  # 50% mark
        # Extract a distinctive phrase
        words = mid_text.split()
        if len(words) > 5:
            phrase = " ".join(words[2:8])
            comments.append(("mid_spoiler", f"I loved when they said {phrase}"))
            comments.append(("mid_spoiler2", f"The part where {phrase} was so unexpected"))

    # Comments referencing late content (DEFINITELY spoilers)
    if len(excerpts) >= 4:
        late_text = excerpts[3][1]  # 75% mark
        words = late_text.split()
        if len(words) > 5:
            phrase = " ".join(words[1:7])
            comments.append(("late_spoiler", f"Can't believe {phrase} happened"))

    if len(excerpts) >= 5:
        end_text = excerpts[4][1]  # 90% mark
        words = end_text.split()
        if len(words) > 5:
            phrase = " ".join(words[0:8])
            comments.append(("end_spoiler", f"The ending where {phrase} was incredible"))

    # Simulate user at 25% through the video
    current_time = duration * 0.25
    print(f"\nUSER POSITION: {current_time:.0f}s ({current_time/60:.1f}min) = 25%")
    print(f"\nTesting {len(comments)} comments:\n")

    # Call API
    payload = {
        "videoId": video_id,
        "currentTime": current_time,
        "videoDuration": duration,
        "comments": [{"id": cid, "text": text} for cid, text in comments],
    }

    async with httpx.AsyncClient(timeout=180) as client:
        resp = await client.post(API_URL, json=payload)
        result = resp.json()

    if not result["transcriptAvailable"]:
        print("  Transcript not available via API")
        return

    print(f"  {'ID':<14} {'COMMENT':<50} {'EST.TIME':>9} {'SPOILER?':>9} {'CONF':>6} {'CORRECT':>8}")
    print(f"  {'-'*100}")

    correct = 0
    total = 0
    for r, (cid, text) in zip(result["results"], comments):
        ts = r["estimatedTimestamp"]
        ts_str = f"{ts/60:.1f}m" if ts else "N/A"
        flagged = r["isSpoiler"] and r["confidence"] > 0.5  # lower threshold for testing

        # Determine expected result
        is_generic = cid.startswith("generic")
        is_early = cid.startswith("early")
        expected_spoiler = not (is_generic or is_early)

        if is_generic:
            match = "n/a"
        elif flagged == expected_spoiler:
            match = "OK"
            correct += 1
        else:
            match = "MISS"

        total += 0 if is_generic else 1

        display = text[:47] + "..." if len(text) > 50 else text
        flag_str = "SPOILER" if flagged else ""
        print(f"  {cid:<14} {display:<50} {ts_str:>9} {flag_str:>9} {r['confidence']:.3f} {match:>8}")

    if total > 0:
        print(f"\n  ACCURACY: {correct}/{total} ({100*correct/total:.0f}%)")


async def main():
    print("SPOILERIE — MrBeast Content-Specific Test")
    print("="*80)
    print("Strategy: read actual transcript, craft comments referencing specific content,")
    print("then check if classifier correctly spots future-content spoilers.\n")
    print("User is simulated at 25% through each video.")
    print("Comments about 50%/75%/90% content SHOULD be flagged as spoilers.")

    videos = [
        "zRtGL0-5rg4",  # Last To Leave Grocery Store
        "DXVHmGoCTco",  # 50 Streamers Fight for $1M
        "JFtlf8RoPZY",  # Trapped On An Island
        "AoN1K4c7VKE",  # Survive 30 Days Stranded With Your Ex
        "5OLs1GWB4OA",  # I Built 10 Schools
    ]

    for vid in videos:
        try:
            await test_video(vid)
        except Exception as e:
            print(f"\n  ERROR on {vid}: {e}")
            import traceback
            traceback.print_exc()

    print(f"\n{'='*80}")
    print("DONE — model uses paraphrase-multilingual-MiniLM-L12-v2 (no fine-tuning)")


if __name__ == "__main__":
    asyncio.run(main())
