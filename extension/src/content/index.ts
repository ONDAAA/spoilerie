import { Comment, AnalyzeRequest, AnalyzeResponse, TranscriptSegment } from "../utils/types";

const ANALYZE_INTERVAL_MS = 5000;
const SPOILER_CLASS = "spoilerie-spoiler";
const MIN_COMMENT_LENGTH = 15;

let enabled = true;
let analyzing = false;
let sessionSpoilersHidden = 0;
let processedCommentIds = new Set<string>();
let cachedTranscript: TranscriptSegment[] | null = null;
let cachedVideoId: string | null = null;

// ── YouTube DOM helpers ────────────────────────────────────────────────────

function getVideoId(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("v");
}

function getVideoElement(): HTMLVideoElement | null {
  return document.querySelector("video.html5-main-video");
}

function getCurrentTime(): number {
  const el = getVideoElement();
  if (!el || el.readyState < 1) return -1;
  return el.currentTime;
}

function getVideoDuration(): number {
  const el = getVideoElement();
  if (!el || el.readyState < 1) return 0;
  return el.duration;
}

function scrapeVisibleComments(): Comment[] {
  const nodes = document.querySelectorAll(
    "ytd-comment-thread-renderer #content-text"
  );
  const comments: Comment[] = [];
  nodes.forEach((el, index) => {
    const text = el.textContent?.trim();
    if (!text || text.length < MIN_COMMENT_LENGTH) return;
    const id = `c${index}_${hashCode(text)}`;
    comments.push({ id, text, element: el });
  });
  return comments;
}

function hashCode(str: string): string {
  let hash = 0;
  for (let i = 0; i < Math.min(str.length, 128); i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

// ── Transcript (received from MAIN world script via postMessage) ───────────

function fetchTranscript(): Promise<TranscriptSegment[] | null> {
  const videoId = getVideoId();
  if (cachedTranscript && cachedVideoId === videoId) {
    return Promise.resolve(cachedTranscript);
  }

  return new Promise((resolve) => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type !== "SPOILERIE_TRANSCRIPT") return;
      window.removeEventListener("message", handler);
      clearTimeout(timeout);

      if (e.data.segments && e.data.segments.length > 0) {
        cachedTranscript = e.data.segments;
        cachedVideoId = videoId;
        console.log(`[Spoilerie] Got ${e.data.segments.length} transcript segments`);
        resolve(e.data.segments);
      } else {
        resolve(null);
      }
    };

    window.addEventListener("message", handler);

    // Ask the MAIN world script for transcript
    window.postMessage({ type: "SPOILERIE_REQUEST_TRANSCRIPT" }, "*");

    // Timeout after 8s
    const timeout = setTimeout(() => {
      window.removeEventListener("message", handler);
      console.warn("[Spoilerie] Transcript fetch timed out");
      resolve(null);
    }, 8000);
  });
}

// ── Spoiler overlay ────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById("spoilerie-styles")) return;
  const style = document.createElement("style");
  style.id = "spoilerie-styles";
  style.textContent = `
    .${SPOILER_CLASS} {
      position: relative;
      filter: blur(4px);
      user-select: none;
      cursor: pointer;
      transition: filter 0.2s;
    }
    .${SPOILER_CLASS}::after {
      content: "\\26A0  Spoiler — click to reveal";
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      color: #fff;
      background: rgba(0,0,0,0.45);
      border-radius: 4px;
      pointer-events: none;
    }
    .${SPOILER_CLASS}.revealed {
      filter: none;
      cursor: default;
    }
    .${SPOILER_CLASS}.revealed::after {
      display: none;
    }
  `;
  document.head.appendChild(style);
}

function markAsSpoiler(el: Element) {
  if (el.classList.contains(SPOILER_CLASS)) return;
  el.classList.add(SPOILER_CLASS);
  el.addEventListener("click", function reveal() {
    el.classList.add("revealed");
    el.removeEventListener("click", reveal);
  });
  sessionSpoilersHidden++;
}

function clearAllSpoilers() {
  document.querySelectorAll(`.${SPOILER_CLASS}`).forEach((el) => {
    el.classList.remove(SPOILER_CLASS, "revealed");
  });
  sessionSpoilersHidden = 0;
  processedCommentIds.clear();
  cachedTranscript = null;
  cachedVideoId = null;
}

// ── Analysis loop ──────────────────────────────────────────────────────────

async function analyzeComments() {
  if (!enabled || analyzing) return;

  const videoId = getVideoId();
  if (!videoId) return;

  const currentTime = getCurrentTime();
  if (currentTime < 0) return;

  const videoDuration = getVideoDuration();
  if (videoDuration <= 0) return;

  const allComments = scrapeVisibleComments();
  const newComments = allComments.filter((c) => !processedCommentIds.has(c.id));
  if (newComments.length === 0) return;

  analyzing = true;
  try {
    // Get transcript from MAIN world (browser-side, no rate limits)
    const transcript = await fetchTranscript();

    const body: AnalyzeRequest = {
      videoId,
      currentTime,
      videoDuration,
      comments: newComments.map(({ id, text }) => ({ id, text })),
      transcript: transcript || undefined,
    };

    console.log(`[Spoilerie] Analyzing ${newComments.length} comments (video=${videoId}, time=${currentTime.toFixed(0)}s, transcript=${transcript ? transcript.length + " segs" : "none"})`);

    const data: AnalyzeResponse & { error?: string } = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "API_ANALYZE", payload: body }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message, results: [], transcriptAvailable: false });
          return;
        }
        resolve(response);
      });
    });

    if (data.error) {
      console.warn(`[Spoilerie] API error: ${data.error}`);
      return;
    }

    if (!data.transcriptAvailable) {
      console.log("[Spoilerie] No transcript available for this video");
      chrome.runtime.sendMessage({ type: "STATUS_UPDATE", status: "no_transcript" });
      return;
    }

    chrome.runtime.sendMessage({ type: "STATUS_UPDATE", status: "active" });

    const elementMap = new Map(newComments.map((c) => [c.id, c.element]));
    let spoilersThisRound = 0;

    for (const result of data.results) {
      processedCommentIds.add(result.commentId);
      if (result.isSpoiler && result.confidence > 0.5) {
        const el = elementMap.get(result.commentId);
        if (el) {
          markAsSpoiler(el);
          spoilersThisRound++;
        }
      }
    }

    console.log(`[Spoilerie] Found ${spoilersThisRound} spoilers in ${data.results.length} comments`);
    chrome.storage.local.set({ spoilersHidden: sessionSpoilersHidden });
  } catch (err) {
    console.warn("[Spoilerie] analyze failed:", err);
  } finally {
    analyzing = false;
  }
}

// ── Navigation (YouTube is a SPA) ─────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;

function startLoop() {
  if (intervalId) clearInterval(intervalId);
  intervalId = setInterval(analyzeComments, ANALYZE_INTERVAL_MS);
  analyzeComments();
}

function stopLoop() {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
  clearAllSpoilers();
}

document.addEventListener("yt-navigate-finish", () => {
  clearAllSpoilers();
  if (getVideoId()) startLoop();
  else stopLoop();
});

// ── Init ──────────────────────────────────────────────────────────────────

chrome.storage.local.get(["enabled"], (result) => {
  enabled = result.enabled ?? true;
  injectStyles();
  console.log("[Spoilerie] Content script loaded, enabled:", enabled);
  if (getVideoId()) startLoop();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "SET_ENABLED") {
    enabled = msg.enabled;
    if (!enabled) clearAllSpoilers();
    else if (getVideoId()) startLoop();
  }
  if (msg.type === "GET_STATUS") {
    sendResponse({ status: getVideoId() ? "active" : "idle" });
    return true;
  }
});
