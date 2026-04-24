/**
 * Background service worker — proxies all API calls from content script.
 * This avoids CORS issues entirely since background scripts have no origin restrictions.
 */

const DEFAULT_API_BASE = "http://localhost:8000";

// Get API base from storage, fallback to default
async function getApiBase(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.local.get(["apiBase"], (result) => {
      resolve(result.apiBase || DEFAULT_API_BASE);
    });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "API_ANALYZE") {
    handleAnalyze(msg.payload)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // keep channel open for async response
  }

  if (msg.type === "STATUS_UPDATE" && sender.tab?.id) {
    chrome.storage.local.set({ lastStatus: msg.status });
  }
});

async function handleAnalyze(payload: unknown): Promise<unknown> {
  const apiBase = await getApiBase();

  const res = await fetch(`${apiBase}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`API returned ${res.status}`);
  }

  return res.json();
}

// Reset session counter when navigating away from a video
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" && tab.url && !tab.url.includes("youtube.com/watch")) {
    chrome.storage.local.set({ spoilersHidden: 0 });
  }
});
