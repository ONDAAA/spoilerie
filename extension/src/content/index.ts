import { Comment, AnalyzeRequest, AnalyzeResponse, TranscriptSegment } from "../utils/types";

const ANALYZE_INTERVAL_MS = 5000;
const SPOILER_CLASS = "spoilerie-spoiler";
const PENDING_CLASS = "spoilerie-pending";
const SAFE_CLASS = "spoilerie-safe";
const MIN_COMMENT_LENGTH = 15;
const TIMESTAMP_RE = /(?:^|[\s@(])(\d{1,2}):(\d{2})(?::(\d{2}))?(?=[\s,.)!?]|$)/;

let enabled = true;
let analyzing = false;
let sessionSpoilersHidden = 0;
let processedCommentIds = new Set<string>();
let cachedTranscript: TranscriptSegment[] | null = null;
let cachedVideoId: string | null = null;
let transcriptFailed = false;
let commentObserver: MutationObserver | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let transcriptSentForVideo: string | null = null;
let spoilerTimestamps = new Map<Element, number>();
let sensitivity: "low" | "medium" | "high" = "medium";

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
    // Skip emoji-only / link-only comments
    if (isJunkComment(text)) return;
    const id = `c${index}_${hashCode(text)}`;
    comments.push({ id, text, element: el });
  });
  return comments;
}

function isJunkComment(text: string): boolean {
  // Remove emojis and whitespace
  const stripped = text.replace(/[\u{1F600}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F000}-\u{1FFFF}\s]/gu, "");
  if (stripped.length < 5) return true;
  // Link-only
  if (/^https?:\/\/\S+$/.test(text.trim())) return true;
  return false;
}

function hashCode(str: string): string {
  let hash = 0;
  for (let i = 0; i < Math.min(str.length, 128); i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

// ── Timestamp detection (instant, no ML needed) ────────────────────────────

function parseTimestampFromComment(text: string): number | null {
  const match = text.match(TIMESTAMP_RE);
  if (!match) return null;
  if (match[3]) {
    return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]);
  }
  return parseInt(match[1]) * 60 + parseInt(match[2]);
}

// ── MutationObserver for lazy-loaded comments ──────────────────────────────

function startCommentObserver() {
  if (commentObserver) return;

  const target =
    document.querySelector("ytd-comments#comments") ||
    document.querySelector("#comments") ||
    document.querySelector("ytd-item-section-renderer#sections");

  if (!target) {
    setTimeout(startCommentObserver, 2000);
    return;
  }

  commentObserver = new MutationObserver((mutations) => {
    // Only trigger on actual comment thread elements being added
    let hasNewComment = false;
    for (const m of mutations) {
      for (let i = 0; i < m.addedNodes.length; i++) {
        const node = m.addedNodes[i];
        if (node instanceof HTMLElement && (
          node.tagName === "YTD-COMMENT-THREAD-RENDERER" ||
          node.querySelector?.("ytd-comment-thread-renderer")
        )) {
          hasNewComment = true;
          break;
        }
      }
      if (hasNewComment) break;
    }
    if (hasNewComment) {
      blurNewComments();
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(analyzeComments, 500);
    }
  });

  // Only watch direct children, not deep subtree
  commentObserver.observe(target, { childList: true, subtree: true });
  console.log("[Spoilerie] Comment observer started");
}

function stopCommentObserver() {
  if (commentObserver) {
    commentObserver.disconnect();
    commentObserver = null;
  }
}

// ── Preemptive blur (blur-first, reveal-safe) ──────────────────────────────

function blurNewComments() {
  if (!cachedTranscript) return;
  const nodes = document.querySelectorAll(
    "ytd-comment-thread-renderer #content-text"
  );
  nodes.forEach((el) => {
    if (
      !el.classList.contains(SPOILER_CLASS) &&
      !el.classList.contains(PENDING_CLASS) &&
      !el.classList.contains(SAFE_CLASS) &&
      !el.classList.contains("revealed")
    ) {
      const text = el.textContent?.trim();
      if (text && text.length >= MIN_COMMENT_LENGTH && !isJunkComment(text)) {
        const id = `c${Array.from(nodes).indexOf(el)}_${hashCode(text)}`;
        if (!processedCommentIds.has(id)) {
          el.classList.add(PENDING_CLASS);
        }
      }
    }
  });
}

function unblurSafe(el: Element) {
  el.classList.remove(PENDING_CLASS);
  el.classList.add(SAFE_CLASS);
}

// ── Transcript (received from MAIN world script via postMessage) ───────────

function fetchTranscript(): Promise<TranscriptSegment[] | null> {
  const videoId = getVideoId();
  if (cachedTranscript && cachedVideoId === videoId) {
    return Promise.resolve(cachedTranscript);
  }
  if (transcriptFailed && cachedVideoId === videoId) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type !== "SPOILERIE_TRANSCRIPT") return;
      window.removeEventListener("message", handler);
      clearTimeout(timeout);

      if (e.data.segments && e.data.segments.length > 0) {
        cachedTranscript = e.data.segments;
        cachedVideoId = videoId;
        transcriptFailed = false;
        console.log(`[Spoilerie] Got ${e.data.segments.length} transcript segments`);
        resolve(e.data.segments);
      } else {
        cachedVideoId = videoId;
        transcriptFailed = true;
        console.log("[Spoilerie] No transcript found — won't retry for this video");
        resolve(null);
      }
    };

    window.addEventListener("message", handler);
    window.postMessage({ type: "SPOILERIE_REQUEST_TRANSCRIPT" }, "*");

    const timeout = setTimeout(() => {
      window.removeEventListener("message", handler);
      console.warn("[Spoilerie] Transcript fetch timed out");
      resolve(null);
    }, 10000);
  });
}

// ── Spoiler overlay ────────────────────────────────────────────────────────

function getConfidenceThreshold(): number {
  if (sensitivity === "low") return 0.6;
  if (sensitivity === "high") return 0.35;
  return 0.5; // medium
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function injectStyles() {
  if (document.getElementById("spoilerie-styles")) return;
  const style = document.createElement("style");
  style.id = "spoilerie-styles";
  style.textContent = `
    .${PENDING_CLASS} {
      filter: blur(4px);
      user-select: none;
      transition: filter 0.3s;
    }
    .${SAFE_CLASS} {
      animation: spoilerie-reveal 0.4s ease;
    }
    @keyframes spoilerie-reveal {
      0% { filter: blur(4px); }
      50% { filter: blur(0); background: rgba(34,197,94,0.08); }
      100% { filter: none; background: transparent; }
    }
    .${SPOILER_CLASS} {
      position: relative;
      filter: blur(4px);
      user-select: none;
      cursor: pointer;
      transition: filter 0.3s;
    }
    .${SPOILER_CLASS}::after {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 2px;
      font-size: 12px;
      color: #fff;
      background: rgba(0,0,0,0.45);
      border-radius: 4px;
      pointer-events: none;
    }
    .${SPOILER_CLASS}.revealed {
      filter: none;
      cursor: default;
      animation: spoilerie-reveal 0.3s ease;
    }
    .${SPOILER_CLASS}.revealed::after {
      display: none;
    }
  `;
  document.head.appendChild(style);
}

function markAsSpoiler(el: Element, estimatedTimestamp?: number) {
  if (el.classList.contains(SPOILER_CLASS)) return;
  el.classList.add(SPOILER_CLASS);

  // Set the ::after content with timestamp hint
  const timeHint = estimatedTimestamp != null
    ? `Spoiler from ~${formatTime(estimatedTimestamp)} — click to reveal`
    : `Spoiler detected — click to reveal`;
  (el as HTMLElement).style.setProperty("--spoiler-text", `"\\26A0  ${timeHint}"`);

  // Use CSS custom property for ::after content
  const styleEl = document.getElementById("spoilerie-styles");
  if (styleEl && !styleEl.textContent?.includes("var(--spoiler-text)")) {
    styleEl.textContent = styleEl.textContent!.replace(
      `.${SPOILER_CLASS}::after {`,
      `.${SPOILER_CLASS}::after { content: var(--spoiler-text, "\\26A0  Spoiler — click to reveal");`
    );
  }

  el.addEventListener("click", function reveal() {
    el.classList.add("revealed");
    spoilerTimestamps.delete(el);
    el.removeEventListener("click", reveal);
  });
  if (estimatedTimestamp != null) {
    spoilerTimestamps.set(el, estimatedTimestamp);
  }
  sessionSpoilersHidden++;
}

function revealPassedSpoilers() {
  const currentTime = getCurrentTime();
  if (currentTime < 0) return;

  let revealed = 0;
  for (const [el, timestamp] of spoilerTimestamps) {
    if (currentTime >= timestamp) {
      el.classList.remove(SPOILER_CLASS);
      el.classList.add("revealed");
      spoilerTimestamps.delete(el);
      sessionSpoilersHidden = Math.max(0, sessionSpoilersHidden - 1);
      revealed++;
    }
  }
  if (revealed > 0) {
    console.log(`[Spoilerie] Auto-revealed ${revealed} spoilers (user passed their timestamps)`);
    chrome.storage.local.set({ spoilersHidden: sessionSpoilersHidden });
    updateBadge();
  }
}

function clearAllSpoilers() {
  document.querySelectorAll(`.${SPOILER_CLASS}, .${PENDING_CLASS}, .${SAFE_CLASS}`).forEach((el) => {
    el.classList.remove(SPOILER_CLASS, PENDING_CLASS, SAFE_CLASS, "revealed");
    (el as HTMLElement).style.removeProperty("--spoiler-text");
  });
  sessionSpoilersHidden = 0;
  processedCommentIds.clear();
  spoilerTimestamps.clear();
  cachedTranscript = null;
  cachedVideoId = null;
  transcriptFailed = false;
  transcriptSentForVideo = null;
  seekListenerAttached = false;
  updateBadge();
}

// ── Badge count on extension icon ──────────────────────────────────────────

function updateBadge() {
  if (!isExtensionAlive()) return;
  try {
    if (sessionSpoilersHidden > 0) {
      chrome.action.setBadgeText({ text: String(sessionSpoilersHidden) });
      chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
  } catch {
    // action API may not be available in content script context
    chrome.runtime.sendMessage({
      type: "SET_BADGE",
      count: sessionSpoilersHidden,
    });
  }
}

// ── Extension context check ────────────────────────────────────────────────

function isExtensionAlive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

// ── Seek detection ─────────────────────────────────────────────────────────

let seekListenerAttached = false;

function setupSeekDetection() {
  if (seekListenerAttached) return;
  const video = getVideoElement();
  if (!video) return;

  video.addEventListener("seeked", () => {
    revealPassedSpoilers();
    reAnalyzeProcessedComments();
  });
  seekListenerAttached = true;
}

function reAnalyzeProcessedComments() {
  const currentTime = getCurrentTime();
  if (currentTime < 0) return;

  // For spoilers whose timestamp is now in the past, reveal them
  revealPassedSpoilers();

  // For safe comments that were revealed, check if user seeked backwards
  // In that case, previously safe comments might now be spoilers
  // We'd need to re-run ML for this — mark processed as needing recheck
  // For now, only handle forward-seek (revealing)
}

// ── Analysis loop ──────────────────────────────────────────────────────────

async function analyzeComments() {
  if (!enabled || analyzing) return;
  if (!isExtensionAlive()) {
    console.log("[Spoilerie] Extension reloaded — stopping");
    stopLoop();
    return;
  }

  const videoId = getVideoId();
  if (!videoId) return;

  const currentTime = getCurrentTime();
  if (currentTime < 0) return;

  const videoDuration = getVideoDuration();
  if (videoDuration <= 0) return;

  const allComments = scrapeVisibleComments();
  const newComments = allComments.filter((c) => !processedCommentIds.has(c.id));

  if (newComments.length === 0) return;

  // Phase 1: Instant timestamp-based detection (no ML, no network)
  const commentsNeedingML: typeof newComments = [];
  const threshold = getConfidenceThreshold();

  for (const comment of newComments) {
    const ts = parseTimestampFromComment(comment.text);
    if (ts !== null) {
      // Comment explicitly mentions a timestamp
      processedCommentIds.add(comment.id);
      comment.element.classList.remove(PENDING_CLASS);
      if (ts > currentTime) {
        markAsSpoiler(comment.element, ts);
      } else {
        unblurSafe(comment.element);
      }
    } else {
      commentsNeedingML.push(comment);
    }
  }

  if (commentsNeedingML.length === 0) {
    updateBadge();
    return;
  }

  // Phase 2: ML-based detection (send to backend)
  analyzing = true;
  try {
    const transcript = await fetchTranscript();

    const includeTranscript = transcript && transcriptSentForVideo !== videoId;

    const body: AnalyzeRequest = {
      videoId,
      currentTime,
      videoDuration,
      comments: commentsNeedingML.map(({ id, text }) => ({ id, text })),
      transcript: includeTranscript ? transcript : undefined,
    };

    if (includeTranscript) {
      transcriptSentForVideo = videoId;
    }

    console.log(`[Spoilerie] Analyzing ${commentsNeedingML.length} comments (video=${videoId}, time=${currentTime.toFixed(0)}s, transcript=${includeTranscript ? "sending" : "cached"})`);

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
      // Unblur pending since we can't determine
      commentsNeedingML.forEach((c) => unblurSafe(c.element));
      return;
    }

    if (!data.transcriptAvailable) {
      console.log("[Spoilerie] No transcript available for this video");
      chrome.runtime.sendMessage({ type: "STATUS_UPDATE", status: "no_transcript" });
      commentsNeedingML.forEach((c) => unblurSafe(c.element));
      return;
    }

    chrome.runtime.sendMessage({ type: "STATUS_UPDATE", status: "active" });

    const elementMap = new Map(commentsNeedingML.map((c) => [c.id, c.element]));
    let spoilersThisRound = 0;

    for (const result of data.results) {
      processedCommentIds.add(result.commentId);
      const el = elementMap.get(result.commentId);
      if (!el) continue;

      if (result.isSpoiler && result.confidence > threshold) {
        el.classList.remove(PENDING_CLASS);
        markAsSpoiler(el, result.estimatedTimestamp ?? undefined);
        spoilersThisRound++;
      } else {
        unblurSafe(el);
      }
    }

    console.log(`[Spoilerie] Found ${spoilersThisRound} spoilers in ${data.results.length} comments (total hidden: ${sessionSpoilersHidden})`);
    chrome.storage.local.set({ spoilersHidden: sessionSpoilersHidden });
    updateBadge();
  } catch (err) {
    console.warn("[Spoilerie] analyze failed:", err);
    commentsNeedingML.forEach((c) => unblurSafe(c.element));
  } finally {
    analyzing = false;
  }
}

// ── Navigation (YouTube is a SPA) ─────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;

function startLoop() {
  if (intervalId) clearInterval(intervalId);
  intervalId = setInterval(() => {
    analyzeComments();
    revealPassedSpoilers();
  }, ANALYZE_INTERVAL_MS);
  analyzeComments();
  startCommentObserver();
  setupSeekDetection();
}

function stopLoop() {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
  stopCommentObserver();
  clearAllSpoilers();
}

// YouTube SPA navigation — fires when user clicks a video link
document.addEventListener("yt-navigate-finish", () => {
  console.log("[Spoilerie] SPA navigation detected");
  stopLoop();
  clearAllSpoilers();
  if (getVideoId()) {
    // Small delay to let YouTube's player initialize
    setTimeout(() => startLoop(), 1500);
  }
});

// Also handle initial page load (non-SPA) and popstate (back/forward)
window.addEventListener("popstate", () => {
  clearAllSpoilers();
  if (getVideoId()) {
    setTimeout(() => startLoop(), 1500);
  }
});

// ── Init ──────────────────────────────────────────────────────────────────

chrome.storage.local.get(["enabled", "sensitivity"], (result) => {
  enabled = result.enabled ?? true;
  sensitivity = result.sensitivity ?? "medium";
  injectStyles();
  console.log(`[Spoilerie] Content script loaded, enabled: ${enabled}, sensitivity: ${sensitivity}`);
  if (getVideoId()) startLoop();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "SET_ENABLED") {
    enabled = msg.enabled;
    if (!enabled) clearAllSpoilers();
    else if (getVideoId()) startLoop();
  }
  if (msg.type === "SET_SENSITIVITY") {
    sensitivity = msg.sensitivity;
  }
  if (msg.type === "GET_STATUS") {
    sendResponse({ status: getVideoId() ? "active" : "idle" });
    return true;
  }
});
