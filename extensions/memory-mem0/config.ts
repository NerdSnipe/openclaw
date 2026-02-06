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
};

const DEFAULT_API_URL = "http://localhost:8080";
const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_SEARCH_THRESHOLD = 0.3;

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
      };
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      ["apiUrl", "userId", "agentId", "autoCapture", "autoRecall", "autoPromote", "searchDefaults"],
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
  },
};
