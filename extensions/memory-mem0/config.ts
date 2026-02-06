export type MemoryCategory =
  | "preference"
  | "fact"
  | "decision"
  | "contact"
  | "skill"
  | "relationship"
  | "context";

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
};

const DEFAULT_API_URL = "http://localhost:8080";
const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_SEARCH_THRESHOLD = 0.3;

const DEFAULT_MAX_MEMORY_CHARS = 300;
const DEFAULT_MAX_PER_CONVERSATION = 3;

const DEFAULT_RECALL_LIMIT = 3;
const DEFAULT_MAX_CONTEXT_CHARS = 1500;
const DEFAULT_RECALL_TIMEOUT_MS = 3000;

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

const DEFAULT_RECALL = {
  limit: DEFAULT_RECALL_LIMIT,
  maxContextChars: DEFAULT_MAX_CONTEXT_CHARS,
  timeoutMs: DEFAULT_RECALL_TIMEOUT_MS,
  minScore: undefined,
  includeCategory: true,
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
        recall: { ...DEFAULT_RECALL },
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
        "recall",
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
      recall: parseRecall(cfg.recall),
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
  },
};
