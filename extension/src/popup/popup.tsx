import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

type Status = "idle" | "active" | "no_transcript";

interface PopupState {
  enabled: boolean;
  status: Status;
  spoilersHidden: number;
}

function Popup() {
  const [state, setState] = useState<PopupState>({
    enabled: true,
    status: "idle",
    spoilersHidden: 0,
  });

  useEffect(() => {
    chrome.storage.local.get(["enabled", "spoilersHidden"], (result) => {
      setState((prev) => ({
        ...prev,
        enabled: result.enabled ?? true,
        spoilersHidden: result.spoilersHidden ?? 0,
      }));
    });

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) return;
      // Check if we're on a YouTube video page first
      if (!tab.url?.includes("youtube.com/watch")) {
        setState((prev) => ({ ...prev, status: "idle" }));
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: "GET_STATUS" }, (response) => {
        // Suppress "receiving end does not exist" error
        if (chrome.runtime.lastError) {
          setState((prev) => ({ ...prev, status: "idle" }));
          return;
        }
        if (response?.status) {
          setState((prev) => ({ ...prev, status: response.status }));
        }
      });
    });
  }, []);

  const toggleEnabled = () => {
    const next = !state.enabled;
    setState((prev) => ({ ...prev, enabled: next }));
    chrome.storage.local.set({ enabled: next });
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { type: "SET_ENABLED", enabled: next }, () => {
          // Suppress error if content script not loaded
          void chrome.runtime.lastError;
        });
      }
    });
  };

  const statusLabel: Record<Status, string> = {
    idle: "Not on a YouTube video",
    active: "Protecting comments",
    no_transcript: "No transcript available",
  };

  const statusColor: Record<Status, string> = {
    idle: "#9ca3af",
    active: "#22c55e",
    no_transcript: "#f59e0b",
  };

  return (
    <div style={{ padding: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
        <span style={{ fontSize: "20px" }}>🛡️</span>
        <span style={{ fontWeight: 700, fontSize: "16px" }}>Spoilerie</span>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
        <span style={{ fontSize: "14px" }}>Spoiler protection</span>
        <button
          onClick={toggleEnabled}
          style={{
            background: state.enabled ? "#3b82f6" : "#d1d5db",
            color: "white",
            border: "none",
            borderRadius: "12px",
            padding: "4px 12px",
            cursor: "pointer",
            fontSize: "13px",
          }}
        >
          {state.enabled ? "ON" : "OFF"}
        </button>
      </div>

      <div style={{ fontSize: "13px", color: statusColor[state.status], marginBottom: "12px" }}>
        ● {statusLabel[state.status]}
      </div>

      {state.spoilersHidden > 0 && (
        <div style={{ fontSize: "12px", color: "#6b7280" }}>
          {state.spoilersHidden} spoiler{state.spoilersHidden !== 1 ? "s" : ""} hidden this session
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Popup />);
