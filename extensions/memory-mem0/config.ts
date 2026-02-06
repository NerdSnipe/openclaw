export type MemoryCategory =
  | "preference"
  | "fact"
  | "decision"
  | "contact"
  | "skill"
  | "relationship"
  | "context"
  | "session_summary";

export type Mem0Config = {
  apiUrl: string;
  userId?: string;
  agentId?: string;
  autoCapture: boolean;
  autoRecall: boolean;
  autoPromote: boolean;
  searchDefaults: {
    limit: number;
    threshold: number;
  };
  /** Storage-time quality controls. */
  capture: {
    /** Max chars per stored memory (default: 300). Longer text is truncated at sentence boundary. */
    maxMemoryChars: number;
    /** Max auto-captures per agent_end event (default: 3). */
    maxPerConversation: number;
    /** Auto-detect memory category from content (default: true). */
    categorize: boolean;
  };
  /** Tool-level storage controls for memory_store. */
  store: {
    /** Timeout in ms for the synchronous Redis store (default: 5000). */
    timeoutMs: number;
    /** Store to Redis immediately, then ingest long-term in background (default: true).
     * When false, the tool waits for the full pipeline (LLM + embeddings + vector store). */
    backgroundLongTerm: boolean;
  };
  /** Recall/injection controls for the before_agent_start hook. */
  recall: {
    /** Max memories injected into context (default: 3). */
    limit: number;
    /** Total character cap on the injected memory block (default: 1500). */
    maxContextChars: number;
    /** Timeout in ms for the mem0 search call (default: 3000). On timeout, agent starts without memories. */
    timeoutMs: number;
    /** Optional minimum relevance score (0.0-1.0). Memories below this are dropped. */
    minScore?: number;
    /** Prefix injected memories with their [category] tag (default: true). */
    includeCategory: boolean;
  };
  /** Session continuity: summarize sessions and recall context on greeting. */
  sessionContinuity: {
    /** Enable auto-capture of session summaries at agent_end (default: true). */
    enabled: boolean;
    /** Max characters for the session summary (default: 250). */
    maxSummaryChars: number;
    /** Minimum user messages in a session before a summary is captured (default: 4). */
    minMessages: number;
  };
};

const DEFAULT_API_URL = "http://localhost:8080";
const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_SEARCH_THRESHOLD = 0.3;

const DEFAULT_MAX_MEMORY_CHARS = 300;
const DEFAULT_MAX_PER_CONVERSATION = 3;

const DEFAULT_STORE_TIMEOUT_MS = 5000;
const DEFAULT_BACKGROUND_LONG_TERM = true;

const DEFAULT_RECALL_LIMIT = 3;
const DEFAULT_MAX_CONTEXT_CHARS = 1500;
const DEFAULT_RECALL_TIMEOUT_MS = 3000;

const DEFAULT_SESSION_CONTINUITY_MAX_CHARS = 250;
const DEFAULT_SESSION_CONTINUITY_MIN_MESSAGES = 4;

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) {
    return;
  }
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

const DEFAULT_CAPTURE = {
  maxMemoryChars: DEFAULT_MAX_MEMORY_CHARS,
  maxPerConversation: DEFAULT_MAX_PER_CONVERSATION,
  categorize: true,
} as const;

const DEFAULT_STORE = {
  timeoutMs: DEFAULT_STORE_TIMEOUT_MS,
  backgroundLongTerm: DEFAULT_BACKGROUND_LONG_TERM,
} as const;

const DEFAULT_RECALL = {
  limit: DEFAULT_RECALL_LIMIT,
  maxContextChars: DEFAULT_MAX_CONTEXT_CHARS,
  timeoutMs: DEFAULT_RECALL_TIMEOUT_MS,
  minScore: undefined,
  includeCategory: true,
} as const;

const DEFAULT_SESSION_CONTINUITY = {
  enabled: true,
  maxSummaryChars: DEFAULT_SESSION_CONTINUITY_MAX_CHARS,
  minMessages: DEFAULT_SESSION_CONTINUITY_MIN_MESSAGES,
} as const;

function parseCapture(raw: unknown): Mem0Config["capture"] {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_CAPTURE };
  }
  const c = raw as Record<string, unknown>;
  assertAllowedKeys(c, ["maxMemoryChars", "maxPerConversation", "categorize"], "capture");
  return {
    maxMemoryChars:
      typeof c.maxMemoryChars === "number" ? c.maxMemoryChars : DEFAULT_MAX_MEMORY_CHARS,
    maxPerConversation:
      typeof c.maxPerConversation === "number"
        ? c.maxPerConversation
        : DEFAULT_MAX_PER_CONVERSATION,
    categorize: c.categorize !== false,
  };
}

function parseStore(raw: unknown): Mem0Config["store"] {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_STORE };
  }
  const s = raw as Record<string, unknown>;
  assertAllowedKeys(s, ["timeoutMs", "backgroundLongTerm"], "store");
  return {
    timeoutMs: typeof s.timeoutMs === "number" ? s.timeoutMs : DEFAULT_STORE_TIMEOUT_MS,
    backgroundLongTerm: s.backgroundLongTerm !== false,
  };
}

function parseRecall(raw: unknown): Mem0Config["recall"] {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_RECALL };
  }
  const r = raw as Record<string, unknown>;
  assertAllowedKeys(
    r,
    ["limit", "maxContextChars", "timeoutMs", "minScore", "includeCategory"],
    "recall",
  );
  return {
    limit: typeof r.limit === "number" ? r.limit : DEFAULT_RECALL_LIMIT,
    maxContextChars:
      typeof r.maxContextChars === "number" ? r.maxContextChars : DEFAULT_MAX_CONTEXT_CHARS,
    timeoutMs: typeof r.timeoutMs === "number" ? r.timeoutMs : DEFAULT_RECALL_TIMEOUT_MS,
    minScore: typeof r.minScore === "number" ? r.minScore : undefined,
    includeCategory: r.includeCategory !== false,
  };
}

function parseSessionContinuity(raw: unknown): Mem0Config["sessionContinuity"] {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_SESSION_CONTINUITY };
  }
  const s = raw as Record<string, unknown>;
  assertAllowedKeys(s, ["enabled", "maxSummaryChars", "minMessages"], "sessionContinuity");
  return {
    enabled: s.enabled !== false,
    maxSummaryChars:
      typeof s.maxSummaryChars === "number"
        ? s.maxSummaryChars
        : DEFAULT_SESSION_CONTINUITY_MAX_CHARS,
    minMessages:
      typeof s.minMessages === "number" ? s.minMessages : DEFAULT_SESSION_CONTINUITY_MIN_MESSAGES,
  };
}

export const mem0ConfigSchema = {
  parse(value: unknown): Mem0Config {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      // Return defaults when no config provided
      return {
        apiUrl: DEFAULT_API_URL,
        autoCapture: true,
        autoRecall: true,
        autoPromote: false,
        searchDefaults: {
          limit: DEFAULT_SEARCH_LIMIT,
          threshold: DEFAULT_SEARCH_THRESHOLD,
        },
        capture: { ...DEFAULT_CAPTURE },
        store: { ...DEFAULT_STORE },
        recall: { ...DEFAULT_RECALL },
        sessionContinuity: { ...DEFAULT_SESSION_CONTINUITY },
      };
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      [
        "apiUrl",
        "userId",
        "agentId",
        "autoCapture",
        "autoRecall",
        "autoPromote",
        "searchDefaults",
        "capture",
        "store",
        "recall",
        "sessionContinuity",
      ],
      "memory-mem0 config",
    );

    const apiUrl = typeof cfg.apiUrl === "string" ? resolveEnvVars(cfg.apiUrl) : DEFAULT_API_URL;

    // Validate searchDefaults if provided
    let searchLimit = DEFAULT_SEARCH_LIMIT;
    let searchThreshold = DEFAULT_SEARCH_THRESHOLD;
    if (cfg.searchDefaults && typeof cfg.searchDefaults === "object") {
      const sd = cfg.searchDefaults as Record<string, unknown>;
      assertAllowedKeys(sd, ["limit", "threshold"], "searchDefaults");
      if (typeof sd.limit === "number") {
        searchLimit = sd.limit;
      }
      if (typeof sd.threshold === "number") {
        searchThreshold = sd.threshold;
      }
    }

    return {
      apiUrl,
      userId: typeof cfg.userId === "string" ? cfg.userId : undefined,
      agentId: typeof cfg.agentId === "string" ? cfg.agentId : undefined,
      autoCapture: cfg.autoCapture !== false,
      autoRecall: cfg.autoRecall !== false,
      autoPromote: cfg.autoPromote === true,
      searchDefaults: {
        limit: searchLimit,
        threshold: searchThreshold,
      },
      capture: parseCapture(cfg.capture),
      store: parseStore(cfg.store),
      recall: parseRecall(cfg.recall),
      sessionContinuity: parseSessionContinuity(cfg.sessionContinuity),
    };
  },
  uiHints: {
    apiUrl: {
      label: "Mem0 API URL",
      placeholder: DEFAULT_API_URL,
      help: "URL of the mem0-api Docker service (or use ${MEM0_API_URL})",
    },
    userId: {
      label: "Default User ID",
      placeholder: "default",
      help: "User ID for scoping memories (defaults to agent session user)",
    },
    agentId: {
      label: "Default Agent ID",
      placeholder: "openclaw",
      help: "Agent ID for agent-scoped private memories",
    },
    autoCapture: {
      label: "Auto-Capture",
      help: "Automatically capture important information from conversations",
    },
    autoRecall: {
      label: "Auto-Recall",
      help: "Automatically inject relevant memories into context before agent starts",
    },
    autoPromote: {
      label: "Auto-Promote",
      help: "Automatically promote frequently accessed short-term memories to long-term storage",
      advanced: true,
    },
    "searchDefaults.limit": {
      label: "Search Limit",
      placeholder: "5",
      advanced: true,
    },
    "searchDefaults.threshold": {
      label: "Relevance Threshold",
      placeholder: "0.3",
      advanced: true,
    },
    "capture.maxMemoryChars": {
      label: "Max Memory Length",
      placeholder: String(DEFAULT_MAX_MEMORY_CHARS),
      help: "Maximum characters per stored memory. Longer text is truncated at sentence boundary.",
      advanced: true,
    },
    "capture.maxPerConversation": {
      label: "Max Captures Per Conversation",
      placeholder: String(DEFAULT_MAX_PER_CONVERSATION),
      advanced: true,
    },
    "capture.categorize": {
      label: "Auto-Categorize",
      help: "Automatically detect and tag memory category (preference, fact, decision, etc.)",
      advanced: true,
    },
    "store.timeoutMs": {
      label: "Store Timeout (ms)",
      placeholder: String(DEFAULT_STORE_TIMEOUT_MS),
      help: "Timeout for the fast Redis store path. Long-term ingestion runs in background.",
      advanced: true,
    },
    "store.backgroundLongTerm": {
      label: "Background Long-Term",
      help: "Store to Redis instantly, then ingest into long-term storage asynchronously. Disable to wait for full pipeline.",
      advanced: true,
    },
    "recall.limit": {
      label: "Recall Limit",
      placeholder: String(DEFAULT_RECALL_LIMIT),
      help: "Maximum memories injected into context before each conversation",
    },
    "recall.maxContextChars": {
      label: "Max Context Characters",
      placeholder: String(DEFAULT_MAX_CONTEXT_CHARS),
      help: "Character cap on total injected memory context",
      advanced: true,
    },
    "recall.timeoutMs": {
      label: "Recall Timeout (ms)",
      placeholder: String(DEFAULT_RECALL_TIMEOUT_MS),
      help: "Timeout for memory search. On timeout, agent starts without memories.",
      advanced: true,
    },
    "recall.minScore": {
      label: "Minimum Relevance Score",
      placeholder: "0.0",
      help: "Optional minimum score (0.0-1.0) for memory to be included in recall",
      advanced: true,
    },
    "recall.includeCategory": {
      label: "Show Category Tags",
      help: "Prefix injected memories with their category tag (e.g. [preference], [decision])",
      advanced: true,
    },
    "sessionContinuity.enabled": {
      label: "Session Continuity",
      help: "Automatically summarize sessions and recall context when greeting after /new or /reset",
    },
    "sessionContinuity.maxSummaryChars": {
      label: "Max Summary Length",
      placeholder: String(DEFAULT_SESSION_CONTINUITY_MAX_CHARS),
      help: "Maximum characters for the auto-captured session summary",
      advanced: true,
    },
    "sessionContinuity.minMessages": {
      label: "Min Messages for Summary",
      placeholder: String(DEFAULT_SESSION_CONTINUITY_MIN_MESSAGES),
      help: "Minimum user messages before a session summary is captured",
      advanced: true,
    },
  },
};
