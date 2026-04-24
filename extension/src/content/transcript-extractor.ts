/**
 * Runs in MAIN world — has access to YouTube's JS objects.
 * Extracts captions from the player's already-loaded track data,
 * falling back to timedtext API fetch only if needed.
 */

interface Segment {
  text: string;
  start: number;
  duration: number;
}

function extractAndSendTranscript() {
  try {
    const player = document.querySelector("#movie_player") as any;

    // Method 1: Read captions directly from player's loaded tracks
    // The player stores parsed caption data after loading
    if (player?.getOption) {
      try {
        const trackList = player.getOption("captions", "tracklist");
        if (trackList && trackList.length > 0) {
          // Try to get the currently loaded caption track data
          const captionsData = player.getOption("captions", "track");
          if (captionsData) {
            // Player has captions loaded — try to read them
            console.log("[Spoilerie MAIN] Found loaded caption track");
          }
        }
      } catch {
        // getOption may not be available
      }
    }

    // Method 2: Access caption renderer's cached data
    if (player?.getPlayerResponse) {
      const resp = player.getPlayerResponse();
      const tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks && tracks.length > 0) {
        // Prefer English, fallback to first
        const track = tracks.find((t: any) => t.languageCode === "en") || tracks[0];
        const url = track.baseUrl + "&fmt=json3";

        console.log("[Spoilerie MAIN] Fetching transcript:", track.languageCode);

        fetch(url)
          .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          })
          .then((data) => {
            const segments = parseJson3(data);
            console.log(`[Spoilerie MAIN] Got ${segments.length} segments`);
            window.postMessage({ type: "SPOILERIE_TRANSCRIPT", segments }, "*");
          })
          .catch((err) => {
            console.warn("[Spoilerie MAIN] Timedtext fetch failed:", err.message);
            // Fallback: try to extract from the DOM captions panel
            const domSegments = extractFromCaptionsPanel();
            window.postMessage({ type: "SPOILERIE_TRANSCRIPT", segments: domSegments }, "*");
          });
        return;
      }
    }

    // Method 3: Try ytInitialPlayerResponse
    if ((window as any).ytInitialPlayerResponse) {
      const tracks = (window as any).ytInitialPlayerResponse
        ?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks && tracks.length > 0) {
        const track = tracks.find((t: any) => t.languageCode === "en") || tracks[0];
        const url = track.baseUrl + "&fmt=json3";

        fetch(url)
          .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          })
          .then((data) => {
            const segments = parseJson3(data);
            window.postMessage({ type: "SPOILERIE_TRANSCRIPT", segments }, "*");
          })
          .catch(() => {
            const domSegments = extractFromCaptionsPanel();
            window.postMessage({ type: "SPOILERIE_TRANSCRIPT", segments: domSegments }, "*");
          });
        return;
      }
    }

    // No captions found at all
    window.postMessage({ type: "SPOILERIE_TRANSCRIPT", segments: null }, "*");
  } catch (e) {
    console.warn("[Spoilerie MAIN] Error:", e);
    window.postMessage({ type: "SPOILERIE_TRANSCRIPT", segments: null }, "*");
  }
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

/**
 * Fallback: extract transcript from YouTube's transcript panel in the DOM.
 * User must have the transcript panel available (most videos with captions do).
 * We can open it programmatically and read the segments.
 */
function extractFromCaptionsPanel(): Segment[] | null {
  // Check if transcript segments exist in the DOM
  // YouTube renders them in ytd-transcript-segment-renderer elements
  const segmentEls = document.querySelectorAll(
    "ytd-transcript-segment-renderer, ytd-transcript-segment-list-renderer .segment"
  );

  if (segmentEls.length > 0) {
    const segments: Segment[] = [];
    segmentEls.forEach((el) => {
      const timeEl = el.querySelector(".segment-timestamp, [class*='timestamp']");
      const textEl = el.querySelector(".segment-text, yt-formatted-string, [class*='text']");
      if (timeEl && textEl) {
        const timeStr = timeEl.textContent?.trim() || "0:00";
        const text = textEl.textContent?.trim() || "";
        if (text) {
          segments.push({
            text,
            start: parseTimestamp(timeStr),
            duration: 5,
          });
        }
      }
    });
    if (segments.length > 0) {
      console.log(`[Spoilerie MAIN] Extracted ${segments.length} segments from transcript panel`);
      return segments;
    }
  }

  // Try to open transcript panel by clicking the button
  tryOpenTranscriptPanel();
  return null;
}

function tryOpenTranscriptPanel() {
  // Look for "Show transcript" button in the description/engagement panels
  const buttons = document.querySelectorAll(
    "ytd-video-description-transcript-section-renderer button, " +
    "button[aria-label*='transcript' i], " +
    "button[aria-label*='přepis' i]"  // Czech
  );
  if (buttons.length > 0) {
    console.log("[Spoilerie MAIN] Found transcript button, clicking...");
    (buttons[0] as HTMLElement).click();
    // After clicking, the transcript panel loads async
    // Next request will find the segments in DOM
  }
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

// Auto-run after YouTube initializes (3s delay)
setTimeout(extractAndSendTranscript, 3000);
