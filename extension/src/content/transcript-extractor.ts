/**
 * Runs in MAIN world — has access to YouTube's JS objects.
 *
 * Extraction priority:
 * 1. Timedtext API (json3 format) — most reliable, full transcript
 * 2. Player's loaded caption track data — already in memory
 * 3. Transcript panel DOM — if user has it open or we can open it
 * 4. Video subtitle overlay — read rendered CC text with timestamps
 */

interface Segment {
  text: string;
  start: number;
  duration: number;
}

function extractAndSendTranscript() {
  try {
    const player = document.querySelector("#movie_player") as any;
    let tracks: any[] = [];

    // Get caption tracks from player
    if (player?.getPlayerResponse) {
      const resp = player.getPlayerResponse();
      tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    }

    // Fallback: ytInitialPlayerResponse
    if (tracks.length === 0 && (window as any).ytInitialPlayerResponse) {
      tracks = (window as any).ytInitialPlayerResponse
        ?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    }

    if (tracks.length > 0) {
      // Prefer manual English, then any English, then first track
      const track =
        tracks.find((t: any) => t.languageCode === "en" && !t.kind) ||
        tracks.find((t: any) => t.languageCode === "en") ||
        tracks[0];

      const url = track.baseUrl + "&fmt=json3";
      console.log(`[Spoilerie MAIN] Fetching transcript: ${track.languageCode} (${track.kind || "manual"})`);

      fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((data) => {
          const segments = parseJson3(data);
          console.log(`[Spoilerie MAIN] Got ${segments.length} segments from timedtext`);
          window.postMessage({ type: "SPOILERIE_TRANSCRIPT", segments }, "*");
        })
        .catch((err) => {
          console.warn(`[Spoilerie MAIN] Timedtext failed: ${err.message}, trying fallbacks`);
          tryFallbacks(player);
        });
      return;
    }

    // No tracks at all
    console.log("[Spoilerie MAIN] No caption tracks found, trying fallbacks");
    tryFallbacks(player);
  } catch (e) {
    console.warn("[Spoilerie MAIN] Error:", e);
    window.postMessage({ type: "SPOILERIE_TRANSCRIPT", segments: null }, "*");
  }
}

function tryFallbacks(player: any) {
  // Fallback 1: Read from player's internal caption module
  const playerSegments = extractFromPlayer(player);
  if (playerSegments && playerSegments.length > 0) {
    console.log(`[Spoilerie MAIN] Got ${playerSegments.length} segments from player internals`);
    window.postMessage({ type: "SPOILERIE_TRANSCRIPT", segments: playerSegments }, "*");
    return;
  }

  // Fallback 2: Read from transcript panel DOM
  const domSegments = extractFromTranscriptPanel();
  if (domSegments && domSegments.length > 0) {
    console.log(`[Spoilerie MAIN] Got ${domSegments.length} segments from transcript panel`);
    window.postMessage({ type: "SPOILERIE_TRANSCRIPT", segments: domSegments }, "*");
    return;
  }

  // Fallback 3: Try to open transcript panel, then read DOM
  if (tryOpenTranscriptPanel()) {
    // Panel is being opened — wait for it to load, then re-extract
    setTimeout(() => {
      const retrySegments = extractFromTranscriptPanel();
      if (retrySegments && retrySegments.length > 0) {
        console.log(`[Spoilerie MAIN] Got ${retrySegments.length} segments from opened transcript panel`);
        window.postMessage({ type: "SPOILERIE_TRANSCRIPT", segments: retrySegments }, "*");
      } else {
        // Fallback 4: Read rendered subtitles from video overlay
        const subSegments = extractFromSubtitleOverlay();
        window.postMessage({ type: "SPOILERIE_TRANSCRIPT", segments: subSegments }, "*");
      }
    }, 3000);
    return;
  }

  // Fallback 4: Subtitle overlay
  const subSegments = extractFromSubtitleOverlay();
  window.postMessage({ type: "SPOILERIE_TRANSCRIPT", segments: subSegments }, "*");
}

function parseJson3(data: any): Segment[] {
  const segments: Segment[] = [];
  for (const ev of data.events || []) {
    if (!ev.segs) continue;
    const text = ev.segs.map((s: any) => s.utf8 || "").join("").trim();
    if (!text || text === "\n") continue;
    segments.push({
      text,
      start: (ev.tStartMs || 0) / 1000,
      duration: (ev.dDurationMs || 3000) / 1000,
    });
  }
  return segments;
}

function extractFromPlayer(player: any): Segment[] | null {
  if (!player) return null;

  try {
    // Try to access the player's caption module
    // YouTube player exposes getOption("captions", ...) API
    if (player.getOption) {
      const tracklist = player.getOption("captions", "tracklist");
      if (tracklist && tracklist.length > 0) {
        // The player has loaded caption data
        // Try to get the raw caption track
        const track = player.getOption("captions", "track");
        if (track && track.captionTracks) {
          // Some versions expose the full parsed track
          return null; // Structure varies too much
        }
      }
    }

    // Try accessing internal player data
    // The player stores loaded captions in its internal modules
    if (player.getVideoData) {
      const videoData = player.getVideoData();
      if (videoData?.captions) {
        // Captions might be inline in some cases
        return null;
      }
    }
  } catch {
    // Player API varies between YouTube versions
  }

  return null;
}

function extractFromTranscriptPanel(): Segment[] | null {
  // YouTube renders transcript in these elements
  const segmentEls = document.querySelectorAll(
    "ytd-transcript-segment-renderer"
  );

  if (segmentEls.length === 0) {
    // Try alternative selectors for different YT layouts
    const altEls = document.querySelectorAll(
      "[class*='transcript'] [class*='segment'], " +
      "ytd-transcript-body-renderer .segment-container"
    );
    if (altEls.length === 0) return null;
  }

  const segments: Segment[] = [];
  const els = segmentEls.length > 0 ? segmentEls :
    document.querySelectorAll("[class*='transcript'] [class*='segment']");

  els.forEach((el) => {
    // Find timestamp element
    const timeEl = el.querySelector(
      "[class*='timestamp'], .segment-timestamp"
    );
    // Find text element
    const textEl = el.querySelector(
      "yt-formatted-string, [class*='segment-text'], .segment-text"
    );

    if (!timeEl || !textEl) return;

    const timeStr = timeEl.textContent?.trim() || "";
    const text = textEl.textContent?.trim() || "";

    if (text && timeStr) {
      segments.push({
        text,
        start: parseTimestamp(timeStr),
        duration: 5,
      });
    }
  });

  return segments.length > 0 ? segments : null;
}

function tryOpenTranscriptPanel(): boolean {
  // Look for "Show transcript" button
  const selectors = [
    // Description section transcript button
    "ytd-video-description-transcript-section-renderer button",
    // Engagement panel button
    "button[aria-label*='transcript' i]",
    "button[aria-label*='Transcript' i]",
    // Czech/other languages
    "button[aria-label*='přepis' i]",
    "button[aria-label*='Transkript' i]",
    // More generic - "Show transcript" text in button
    "#description-inner button",
  ];

  for (const sel of selectors) {
    const btn = document.querySelector(sel) as HTMLElement;
    if (btn) {
      console.log("[Spoilerie MAIN] Opening transcript panel...");
      btn.click();
      return true;
    }
  }

  return false;
}

function extractFromSubtitleOverlay(): Segment[] | null {
  // Read currently rendered subtitle from the video player overlay
  // This is a last resort — we only get the current subtitle, not the full transcript
  const captionWindow = document.querySelector(
    ".ytp-caption-window-container .captions-text, " +
    ".ytp-caption-segment, " +
    ".caption-window .caption-visual-line"
  );

  if (captionWindow?.textContent?.trim()) {
    // We can only see the current subtitle — not enough for full analysis
    console.log("[Spoilerie MAIN] Can see subtitle overlay but need full transcript");
  }

  return null;
}

function parseTimestamp(ts: string): number {
  const parts = ts.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

// Listen for requests from content script
window.addEventListener("message", (e) => {
  if (e.data?.type === "SPOILERIE_REQUEST_TRANSCRIPT") {
    extractAndSendTranscript();
  }
});

// Auto-run after YouTube initializes
setTimeout(extractAndSendTranscript, 3000);
