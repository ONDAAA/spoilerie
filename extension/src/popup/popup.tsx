import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

type Status = "idle" | "active" | "no_transcript";
type Sensitivity = "low" | "medium" | "high";

interface PopupState {
  enabled: boolean;
  status: Status;
  spoilersHidden: number;
  sensitivity: Sensitivity;
}

function Popup() {
  const [state, setState] = useState<PopupState>({
    enabled: true,
    status: "idle",
    spoilersHidden: 0,
    sensitivity: "medium",
  });

  useEffect(() => {
    chrome.storage.local.get(["enabled", "spoilersHidden", "sensitivity"], (result) => {
      setState((prev) => ({
        ...prev,
        enabled: result.enabled ?? true,
        spoilersHidden: result.spoilersHidden ?? 0,
        sensitivity: result.sensitivity ?? "medium",
      }));
    });

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) return;
      if (!tab.url?.includes("youtube.com/watch")) {
        setState((prev) => ({ ...prev, status: "idle" }));
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: "GET_STATUS" }, (response) => {
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
          void chrome.runtime.lastError;
        });
      }
    });
  };

  const setSensitivity = (s: Sensitivity) => {
    setState((prev) => ({ ...prev, sensitivity: s }));
    chrome.storage.local.set({ sensitivity: s });
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { type: "SET_SENSITIVITY", sensitivity: s }, () => {
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

  const sensitivityLabels: Record<Sensitivity, string> = {
    low: "Low",
    medium: "Medium",
    high: "High",
  };

  return (
    <div style={{ padding: "16px", minWidth: "280px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
        <img src="../assets/icon48.png" width="24" height="24" alt="" />
        <span style={{ fontWeight: 700, fontSize: "16px" }}>Spoilerie</span>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
        <span style={{ fontSize: "14px" }}>Spoiler protection</span>
        <button
          onClick={toggleEnabled}
          style={{
            background: state.enabled ? "#6366f1" : "#d1d5db",
            color: "white",
            border: "none",
            borderRadius: "12px",
            padding: "4px 14px",
            cursor: "pointer",
            fontSize: "13px",
            fontWeight: 500,
          }}
        >
          {state.enabled ? "ON" : "OFF"}
        </button>
      </div>

      <div style={{ fontSize: "13px", color: statusColor[state.status], marginBottom: "14px" }}>
        {"\u25CF"} {statusLabel[state.status]}
      </div>

      {state.enabled && (
        <div style={{ marginBottom: "14px" }}>
          <div style={{ fontSize: "12px", color: "#9ca3af", marginBottom: "6px" }}>Sensitivity</div>
          <div style={{ display: "flex", gap: "4px" }}>
            {(["low", "medium", "high"] as Sensitivity[]).map((s) => (
              <button
                key={s}
                onClick={() => setSensitivity(s)}
                style={{
                  flex: 1,
                  padding: "5px 0",
                  fontSize: "12px",
                  fontWeight: state.sensitivity === s ? 600 : 400,
                  border: `1px solid ${state.sensitivity === s ? "#6366f1" : "#e5e7eb"}`,
                  borderRadius: "6px",
                  background: state.sensitivity === s ? "rgba(99,102,241,0.1)" : "transparent",
                  color: state.sensitivity === s ? "#6366f1" : "#6b7280",
                  cursor: "pointer",
                }}
              >
                {sensitivityLabels[s]}
              </button>
            ))}
          </div>
        </div>
      )}

      {state.spoilersHidden > 0 && (
        <div style={{
          fontSize: "13px",
          color: "#ef4444",
          background: "rgba(239,68,68,0.08)",
          padding: "8px 10px",
          borderRadius: "6px",
        }}>
          {state.spoilersHidden} spoiler{state.spoilersHidden !== 1 ? "s" : ""} hidden
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Popup />);
