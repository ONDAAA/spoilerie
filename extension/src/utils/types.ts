export interface Comment {
  id: string;
  text: string;
  element: Element;
}

export interface TranscriptSegment {
  text: string;
  start: number;
  duration: number;
}

export interface AnalyzeRequest {
  videoId: string;
  currentTime: number;
  videoDuration: number;
  comments: { id: string; text: string }[];
  transcript?: TranscriptSegment[];
}

export interface AnalyzeResult {
  commentId: string;
  estimatedTimestamp: number | null;
  isSpoiler: boolean;
  confidence: number;
}

export interface AnalyzeResponse {
  results: AnalyzeResult[];
  transcriptAvailable: boolean;
}

export type MessageType =
  | { type: "GET_STATUS" }
  | { type: "SET_ENABLED"; enabled: boolean }
  | { type: "ANALYZE_DONE"; spoilersHidden: number };
