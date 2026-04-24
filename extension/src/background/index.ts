// Service worker — relays status updates from content script to popup storage

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "STATUS_UPDATE" && sender.tab?.id) {
    chrome.storage.local.set({ lastStatus: msg.status });
  }
});

// Reset session counter when navigating away from a video
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" && tab.url && !tab.url.includes("youtube.com/watch")) {
    chrome.storage.local.set({ spoilersHidden: 0 });
  }
});
