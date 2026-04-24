/**
 * Runs in MAIN world — intercepts YouTube's own timedtext fetch.
 *
 * Instead of making our own request (which gets 429'd), we patch
 * window.fetch to capture YouTube player's caption response as it loads.
 * Fallback: read from transcript panel DOM.
 */

interface Segment {
  text: string;
  start: number;
  duration: number;
}

// Store intercepted transcript data
let interceptedSegments: Segment[] | null = null;

// ── Patch fetch to intercept timedtext responses ───────────────────────────

const originalFetch = window.fetch;
window.fetch = async function (...args: Parameters<typeof fetch>) {
  const response = await originalFetch.apply(this, args);

  try {
    const url = typeof args[0] === "string" ? args[0] : (args[0] as Request).url;
    if (url && url.includes("/api/timedtext") && url.includes("fmt=json3")) {
      // Clone response so YouTube can still read it
      const cloned = response.clone();
      cloned.json().then((data) => {
        const segments = parseJson3(data);
        if (segments.length > 0) {
          interceptedSegments = segments;
          console.log(`[Spoilerie MAIN] Intercepted ${segments.length} caption segments from YouTube's own request`);
          // Broadcast immediately
          window.postMessage({ type: "SPOILERIE_TRANSCRIPT", segments }, "*");
        }
      }).catch(() => {});
    }
  } catch {
    // Don't break YouTube if our interception fails
  }

  return response;
};

// Also patch XMLHttpRequest for older YouTube code paths
const originalXHROpen = XMLHttpRequest.prototype.open;
const originalXHRSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
  (this as any)._spoilerieUrl = url?.toString() || "";
  return originalXHROpen.apply(this, [method, url, ...rest] as any);
};

XMLHttpRequest.prototype.send = function (...args: any[]) {
  const url = (this as any)._spoilerieUrl || "";
  if (url.includes("/api/timedtext") && url.includes("fmt=json3")) {
    this.addEventListener("load", function () {
      try {
        const data = JSON.parse(this.responseText);
        const segments = parseJson3(data);
        if (segments.length > 0) {
          interceptedSegments = segments;
          console.log(`[Spoilerie MAIN] Intercepted ${segments.length} caption segments (XHR)`);
          window.postMessage({ type: "SPOILERIE_TRANSCRIPT", segments }, "*");
        }
      } catch {}
    });
  }
  return originalXHRSend.apply(this, args as [body?: Document | XMLHttpRequestBodyInit | null]);
};

// Track which video the intercepted segments belong to
let interceptedVideoUrl = location.href;

console.log("[Spoilerie MAIN] Fetch/XHR interceptor installed");

// ── SPA navigation: reset intercepted data when video changes ──────────────

document.addEventListener("yt-navigate-finish", () => {
  if (location.href !== interceptedVideoUrl) {
    console.log("[Spoilerie MAIN] SPA navigation detected — resetting transcript cache");
    interceptedSegments = null;
    interceptedVideoUrl = location.href;
  }
});

// ── Handle transcript requests from content script ─────────────────────────

window.addEventListener("message", (e) => {
  if (e.data?.type === "SPOILERIE_REQUEST_TRANSCRIPT") {
    // If we already intercepted captions, send them immediately
    if (interceptedSegments && interceptedSegments.length > 0) {
      console.log(`[Spoilerie MAIN] Returning ${interceptedSegments.length} cached intercepted segments`);
      window.postMessage({ type: "SPOILERIE_TRANSCRIPT", segments: interceptedSegments }, "*");
      return;
    }

    // Fallback: try reading from transcript panel DOM
    const domSegments = extractFromTranscriptPanel();
    if (domSegments && domSegments.length > 0) {
      console.log(`[Spoilerie MAIN] Got ${domSegments.length} segments from transcript panel`);
      window.postMessage({ type: "SPOILERIE_TRANSCRIPT", segments: domSegments }, "*");
      return;
    }

    // Fallback: try opening the transcript panel
    if (tryOpenTranscriptPanel()) {
      setTimeout(() => {
        const retrySegments = extractFromTranscriptPanel();
        if (retrySegments && retrySegments.length > 0) {
          console.log(`[Spoilerie MAIN] Got ${retrySegments.length} segments from opened panel`);
          window.postMessage({ type: "SPOILERIE_TRANSCRIPT", segments: retrySegments }, "*");
        } else {
          window.postMessage({ type: "SPOILERIE_TRANSCRIPT", segments: null }, "*");
        }
      }, 3000);
      return;
    }

    // Nothing available
    window.postMessage({ type: "SPOILERIE_TRANSCRIPT", segments: null }, "*");
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────

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

function extractFromTranscriptPanel(): Segment[] | null {
  const segmentEls = document.querySelectorAll("ytd-transcript-segment-renderer");
  if (segmentEls.length === 0) return null;

  const segments: Segment[] = [];
  segmentEls.forEach((el) => {
    const timeEl = el.querySelector("[class*='timestamp']");
    const textEl = el.querySelector("yt-formatted-string, [class*='segment-text']");
    if (!timeEl || !textEl) return;

    const timeStr = timeEl.textContent?.trim() || "";
    const text = textEl.textContent?.trim() || "";
    if (text && timeStr) {
      segments.push({ text, start: parseTimestamp(timeStr), duration: 5 });
    }
  });

  return segments.length > 0 ? segments : null;
}

function tryOpenTranscriptPanel(): boolean {
  const selectors = [
    "ytd-video-description-transcript-section-renderer button",
    "button[aria-label*='transcript' i]",
    "button[aria-label*='Transcript' i]",
    "button[aria-label*='přepis' i]",
    "button[aria-label*='Transkript' i]",
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

function parseTimestamp(ts: string): number {
  const parts = ts.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}
