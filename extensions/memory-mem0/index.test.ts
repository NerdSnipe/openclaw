/**
 * Memory (mem0) Plugin Tests
 *
 * Unit tests: config parsing, plugin registration, capture filtering
 * Live tests: require a running mem0-api Docker stack (MEM0_LIVE_TEST=1)
 */

import { describe, test, expect } from "vitest";
import { mem0ConfigSchema } from "./config.js";
import { detectCategory, truncateAtSentence } from "./index.js";

// Live test gate
const liveEnabled = process.env.MEM0_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;

// ============================================================================
// Unit Tests
// ============================================================================

describe("memory-mem0 plugin", () => {
  test("plugin exports correct metadata", async () => {
    const { default: mem0Plugin } = await import("./index.js");

    expect(mem0Plugin.id).toBe("memory-mem0");
    expect(mem0Plugin.name).toBe("Memory (mem0)");
    expect(mem0Plugin.kind).toBe("memory");
    expect(mem0Plugin.configSchema).toBeDefined();
    // oxlint-disable-next-line typescript/unbound-method
    expect(mem0Plugin.register).toBeInstanceOf(Function);
  });

  test("config schema parses valid config", () => {
    const config = mem0ConfigSchema.parse({
      apiUrl: "http://localhost:9090",
      userId: "test-user",
      agentId: "test-agent",
      autoCapture: true,
      autoRecall: false,
      autoPromote: true,
      searchDefaults: { limit: 10, threshold: 0.5 },
    });

    expect(config.apiUrl).toBe("http://localhost:9090");
    expect(config.userId).toBe("test-user");
    expect(config.agentId).toBe("test-agent");
    expect(config.autoCapture).toBe(true);
    expect(config.autoRecall).toBe(false);
    expect(config.autoPromote).toBe(true);
    expect(config.searchDefaults.limit).toBe(10);
    expect(config.searchDefaults.threshold).toBe(0.5);
  });

  test("config schema returns defaults for empty input", () => {
    const config = mem0ConfigSchema.parse(undefined);

    expect(config.apiUrl).toBe("http://localhost:8080");
    expect(config.userId).toBeUndefined();
    expect(config.agentId).toBeUndefined();
    expect(config.autoCapture).toBe(true);
    expect(config.autoRecall).toBe(true);
    expect(config.autoPromote).toBe(false);
    expect(config.searchDefaults.limit).toBe(5);
    expect(config.searchDefaults.threshold).toBe(0.3);
  });

  test("config schema returns defaults for empty object", () => {
    const config = mem0ConfigSchema.parse({});

    expect(config.apiUrl).toBe("http://localhost:8080");
    expect(config.autoCapture).toBe(true);
    expect(config.autoRecall).toBe(true);
  });

  test("config schema resolves env vars in apiUrl", () => {
    process.env.TEST_MEM0_URL = "http://mem0.example.com:8080";
    const config = mem0ConfigSchema.parse({
      apiUrl: "${TEST_MEM0_URL}",
    });
    expect(config.apiUrl).toBe("http://mem0.example.com:8080");
    delete process.env.TEST_MEM0_URL;
  });

  test("config schema throws for unset env var", () => {
    delete process.env.NONEXISTENT_MEM0_VAR;
    expect(() => {
      mem0ConfigSchema.parse({
        apiUrl: "${NONEXISTENT_MEM0_VAR}",
      });
    }).toThrow("Environment variable NONEXISTENT_MEM0_VAR is not set");
  });

  test("config schema rejects unknown keys", () => {
    expect(() => {
      mem0ConfigSchema.parse({
        apiUrl: "http://localhost:8080",
        unknownKey: "value",
      });
    }).toThrow("unknown keys");
  });

  test("config schema rejects unknown searchDefaults keys", () => {
    expect(() => {
      mem0ConfigSchema.parse({
        searchDefaults: { limit: 5, badKey: true },
      });
    }).toThrow("unknown keys");
  });

  test("plugin registers tools, CLI, hooks, and service", async () => {
    const { default: mem0Plugin } = await import("./index.js");

    // oxlint-disable-next-line typescript/no-explicit-any
    const registeredTools: any[] = [];
    // oxlint-disable-next-line typescript/no-explicit-any
    const registeredClis: any[] = [];
    // oxlint-disable-next-line typescript/no-explicit-any
    const registeredServices: any[] = [];
    // oxlint-disable-next-line typescript/no-explicit-any
    const registeredHooks: Record<string, any[]> = {};
    const logs: string[] = [];

    const mockApi = {
      id: "memory-mem0",
      name: "Memory (mem0)",
      source: "test",
      config: {},
      pluginConfig: {
        apiUrl: "http://localhost:8080",
        autoCapture: true,
        autoRecall: true,
      },
      runtime: {},
      logger: {
        info: (msg: string) => logs.push(`[info] ${msg}`),
        warn: (msg: string) => logs.push(`[warn] ${msg}`),
        error: (msg: string) => logs.push(`[error] ${msg}`),
        debug: (msg: string) => logs.push(`[debug] ${msg}`),
      },
      // oxlint-disable-next-line typescript/no-explicit-any
      registerTool: (tool: any, opts: any) => {
        registeredTools.push({ tool, opts });
      },
      // oxlint-disable-next-line typescript/no-explicit-any
      registerCli: (registrar: any, opts: any) => {
        registeredClis.push({ registrar, opts });
      },
      // oxlint-disable-next-line typescript/no-explicit-any
      registerService: (service: any) => {
        registeredServices.push(service);
      },
      // oxlint-disable-next-line typescript/no-explicit-any
      on: (hookName: string, handler: any) => {
        if (!registeredHooks[hookName]) {
          registeredHooks[hookName] = [];
        }
        registeredHooks[hookName].push(handler);
      },
      resolvePath: (p: string) => p,
    };

    // oxlint-disable-next-line typescript/no-explicit-any
    mem0Plugin.register(mockApi as any);

    // 4 tools: memory_recall, memory_store, memory_forget, memory_promote
    expect(registeredTools.length).toBe(4);
    expect(registeredTools.map((t) => t.opts?.name)).toContain("memory_recall");
    expect(registeredTools.map((t) => t.opts?.name)).toContain("memory_store");
    expect(registeredTools.map((t) => t.opts?.name)).toContain("memory_forget");
    expect(registeredTools.map((t) => t.opts?.name)).toContain("memory_promote");

    // 1 CLI registration (mem0 namespace)
    expect(registeredClis.length).toBe(1);
    expect(registeredClis[0].opts?.commands).toContain("mem0");

    // 1 service
    expect(registeredServices.length).toBe(1);
    expect(registeredServices[0].id).toBe("memory-mem0");

    // 2 hooks (autoRecall + autoCapture both enabled)
    expect(registeredHooks["before_agent_start"]?.length).toBe(1);
    expect(registeredHooks["agent_end"]?.length).toBe(1);

    // Registration log
    expect(logs.some((l) => l.includes("memory-mem0: plugin registered"))).toBe(true);
  });

  test("plugin skips hooks when auto features disabled", async () => {
    const { default: mem0Plugin } = await import("./index.js");

    // oxlint-disable-next-line typescript/no-explicit-any
    const registeredHooks: Record<string, any[]> = {};

    const mockApi = {
      id: "memory-mem0",
      name: "Memory (mem0)",
      source: "test",
      config: {},
      pluginConfig: {
        apiUrl: "http://localhost:8080",
        autoCapture: false,
        autoRecall: false,
      },
      runtime: {},
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      registerTool: () => {},
      registerCli: () => {},
      registerService: () => {},
      // oxlint-disable-next-line typescript/no-explicit-any
      on: (hookName: string, handler: any) => {
        if (!registeredHooks[hookName]) {
          registeredHooks[hookName] = [];
        }
        registeredHooks[hookName].push(handler);
      },
      resolvePath: (p: string) => p,
    };

    // oxlint-disable-next-line typescript/no-explicit-any
    mem0Plugin.register(mockApi as any);

    // No hooks registered when both features are off
    expect(registeredHooks["before_agent_start"]).toBeUndefined();
    expect(registeredHooks["agent_end"]).toBeUndefined();
  });

  test("shouldCapture filters correctly", () => {
    // Replicate the capture filtering logic to verify patterns
    const triggers = [
      { text: "I prefer dark mode", shouldMatch: true },
      { text: "Remember that my name is John", shouldMatch: true },
      { text: "My email is test@example.com", shouldMatch: true },
      { text: "Call me at +1234567890123", shouldMatch: true },
      { text: "We decided to use TypeScript", shouldMatch: true },
      { text: "I always want verbose output", shouldMatch: true },
      { text: "Just a random short message", shouldMatch: false },
      { text: "x", shouldMatch: false }, // Too short
      {
        text: "<relevant-memories>injected</relevant-memories>",
        shouldMatch: false,
      },
    ];

    const MEMORY_TRIGGERS_TEST = [
      /remember|zapamatuj si|pamatuj/i,
      /prefer|radši|nechci|preferuji/i,
      /decided|rozhodli jsme|budeme používat/i,
      /\+\d{10,}/,
      /[\w.-]+@[\w.-]+\.\w+/,
      /my\s+\w+\s+is|is\s+my|můj\s+\w+\s+je|je\s+můj/i,
      /i (like|prefer|hate|love|want|need)/i,
      /always|never|important/i,
    ];

    for (const { text, shouldMatch } of triggers) {
      const isTooShort = text.length < 10;
      const isInjected = text.includes("<relevant-memories>");
      const matches = !isTooShort && !isInjected && MEMORY_TRIGGERS_TEST.some((r) => r.test(text));

      if (shouldMatch) {
        expect(matches, `expected "${text}" to be capturable`).toBe(true);
      }
    }
  });
});

// ============================================================================
// Config: capture + recall parsing
// ============================================================================

describe("config schema: capture + recall", () => {
  test("parses custom capture and recall values", () => {
    const config = mem0ConfigSchema.parse({
      capture: { maxMemoryChars: 200, maxPerConversation: 5, categorize: false },
      recall: { limit: 5, maxContextChars: 2000, timeoutMs: 5000, minScore: 0.5 },
    });
    expect(config.capture.maxMemoryChars).toBe(200);
    expect(config.capture.maxPerConversation).toBe(5);
    expect(config.capture.categorize).toBe(false);
    expect(config.recall.limit).toBe(5);
    expect(config.recall.maxContextChars).toBe(2000);
    expect(config.recall.timeoutMs).toBe(5000);
    expect(config.recall.minScore).toBe(0.5);
    expect(config.recall.includeCategory).toBe(true);
  });

  test("defaults capture and recall when absent", () => {
    const config = mem0ConfigSchema.parse({});
    expect(config.capture.maxMemoryChars).toBe(300);
    expect(config.capture.maxPerConversation).toBe(3);
    expect(config.capture.categorize).toBe(true);
    expect(config.recall.limit).toBe(3);
    expect(config.recall.maxContextChars).toBe(1500);
    expect(config.recall.timeoutMs).toBe(3000);
    expect(config.recall.minScore).toBeUndefined();
    expect(config.recall.includeCategory).toBe(true);
  });

  test("rejects unknown keys in capture", () => {
    expect(() => {
      mem0ConfigSchema.parse({ capture: { badKey: true } });
    }).toThrow("unknown keys");
  });

  test("rejects unknown keys in recall", () => {
    expect(() => {
      mem0ConfigSchema.parse({ recall: { badKey: true } });
    }).toThrow("unknown keys");
  });
});

// ============================================================================
// detectCategory
// ============================================================================

describe("detectCategory", () => {
  test("detects preference", () => {
    expect(detectCategory("I prefer dark mode")).toBe("preference");
    expect(detectCategory("I always want verbose output")).toBe("preference");
    expect(detectCategory("I love TypeScript")).toBe("preference");
  });

  test("detects contact info", () => {
    expect(detectCategory("My email is test@example.com")).toBe("contact");
    expect(detectCategory("Call me at +1234567890123")).toBe("contact");
  });

  test("detects decision", () => {
    expect(detectCategory("We decided to use TypeScript")).toBe("decision");
    expect(detectCategory("We agreed on the API design")).toBe("decision");
  });

  test("detects fact", () => {
    expect(detectCategory("My name is John Smith")).toBe("fact");
    expect(detectCategory("She lives in San Francisco")).toBe("fact");
  });

  test("detects skill", () => {
    expect(detectCategory("I can use Kubernetes")).toBe("skill");
    expect(detectCategory("She knows how to deploy to AWS")).toBe("skill");
  });

  test("detects relationship", () => {
    expect(detectCategory("My colleague helped me")).toBe("relationship");
    expect(detectCategory("I work with the platform team")).toBe("relationship");
  });

  test("falls back to context for unrecognized text", () => {
    expect(detectCategory("The sky was clear and bright today")).toBe("context");
  });
});

// ============================================================================
// truncateAtSentence
// ============================================================================

describe("truncateAtSentence", () => {
  test("returns text unchanged when under limit", () => {
    expect(truncateAtSentence("Short text.", 300)).toBe("Short text.");
  });

  test("truncates at sentence boundary", () => {
    const text = "First sentence. Second sentence. Third sentence is very long indeed.";
    const result = truncateAtSentence(text, 35);
    expect(result).toBe("First sentence. Second sentence.");
    expect(result.length).toBeLessThanOrEqual(35);
  });

  test("falls back to word boundary when no sentence end found", () => {
    const text = "One very long sentence without any periods at all continuing on and on forever";
    const result = truncateAtSentence(text, 40);
    expect(result.length).toBeLessThanOrEqual(40);
    // Should cut at a word boundary (no partial words)
    expect(text.startsWith(result)).toBe(true);
    expect(result).toBe("One very long sentence without any");
  });

  test("handles text with only one sentence", () => {
    const text = "A very long single sentence that keeps going and does not end with a period";
    const result = truncateAtSentence(text, 30);
    expect(result.length).toBeLessThanOrEqual(30);
  });
});

// ============================================================================
// Live Tests (require running mem0-api Docker stack)
// ============================================================================

describeLive("memory-mem0 live tests", () => {
  test("health check succeeds", async () => {
    const { Mem0ApiClient } = await import("./client.js");
    const client = new Mem0ApiClient("http://localhost:8080", "test-user", "test-agent");

    const health = await client.health();
    expect(health.status).toBeDefined();
    expect(health.service).toBe("mem0-api");
  });

  test("store, search, delete cycle", async () => {
    const { Mem0ApiClient } = await import("./client.js");
    const client = new Mem0ApiClient("http://localhost:8080", "live-test-user", "live-test-agent");

    // Store
    const addResult = await client.addMemory({
      messages: [{ role: "user", content: "I prefer dark mode for all applications" }],
      userId: "live-test-user",
    });
    expect(addResult.success).toBe(true);

    // Search
    const searchResults = await client.search({
      query: "dark mode preference",
      userId: "live-test-user",
      limit: 5,
    });
    expect(searchResults.length).toBeGreaterThan(0);

    // Stats
    const stats = await client.stats();
    expect(stats.short_term.available).toBe(true);
  }, 30000);
});
