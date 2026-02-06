/**
 * Thin HTTP client for the mem0-api Docker service.
 * All database operations (Redis, Qdrant, Neo4j, Postgres)
 * happen server-side; this client only makes REST calls.
 */

// ============================================================================
// Types
// ============================================================================

export type Mem0Message = {
  role: string;
  content: string;
};

export type Mem0SearchResult = {
  id: string;
  memory: string;
  score?: number;
  source?: "short_term" | "long_term";
  user_id?: string;
  agent_id?: string;
  metadata?: Record<string, unknown>;
};

export type Mem0AddResult = {
  success: boolean;
  short_term: boolean;
  long_term: boolean;
  memory_key?: string;
  result?: unknown;
};

export type Mem0PromoteResult = {
  promoted_count: number;
  promoted: unknown[];
};

export type Mem0Memory = {
  id: string;
  memory: string;
  source?: string;
  access_count?: number;
  created_at?: string;
  metadata?: Record<string, unknown>;
};

export type Mem0HealthStatus = {
  status: string;
  service: string;
  database: string;
  short_term_memory: string;
  long_term_memory: string;
  graph_memory: string;
};

export type Mem0Stats = {
  database: { available: boolean; history_count: number };
  short_term: { available: boolean; count: number };
  long_term: { available: boolean };
};

export type Mem0Profile = {
  exists: boolean;
  user_id?: string;
  agent_id?: string;
  display_name?: string;
  preferences?: Record<string, unknown>;
  personality?: string;
  private_notes?: string;
  last_seen?: string;
  created_at?: string;
  updated_at?: string;
};

export type Mem0HistoryEntry = {
  id: number;
  operation: string;
  user_id?: string;
  agent_id?: string;
  session_id?: string;
  memory_tier?: string;
  created_at?: string;
};

// ============================================================================
// Client
// ============================================================================

export class Mem0ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly defaultUserId: string,
    private readonly defaultAgentId: string,
  ) {}

  // ---- Health & Stats ----

  async health(): Promise<Mem0HealthStatus> {
    return this.request<Mem0HealthStatus>("/health");
  }

  async stats(): Promise<Mem0Stats> {
    return this.request<Mem0Stats>("/stats");
  }

  async history(params?: { limit?: number }): Promise<Mem0HistoryEntry[]> {
    const qs = params?.limit ? `?limit=${params.limit}` : "";
    const data = await this.request<{ history: Mem0HistoryEntry[] }>(`/history${qs}`);
    return data.history;
  }

  // ---- Memory Operations ----

  async addMemory(params: {
    messages: Mem0Message[];
    userId?: string;
    agentId?: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
    shortTermOnly?: boolean;
  }): Promise<Mem0AddResult> {
    return this.request<Mem0AddResult>("/memories/add", {
      method: "POST",
      body: JSON.stringify({
        messages: params.messages,
        user_id: params.userId ?? this.defaultUserId,
        agent_id: params.agentId ?? this.defaultAgentId,
        session_id: params.sessionId,
        metadata: params.metadata,
        short_term_only: params.shortTermOnly ?? false,
      }),
    });
  }

  async search(params: {
    query: string;
    userId?: string;
    agentId?: string;
    sessionId?: string;
    limit?: number;
    includeShortTerm?: boolean;
  }): Promise<Mem0SearchResult[]> {
    const data = await this.request<{ memories: Mem0SearchResult[]; count: number }>(
      "/memories/search",
      {
        method: "POST",
        body: JSON.stringify({
          query: params.query,
          user_id: params.userId ?? this.defaultUserId,
          agent_id: params.agentId,
          session_id: params.sessionId,
          limit: params.limit ?? 10,
          include_short_term: params.includeShortTerm ?? true,
        }),
      },
    );
    return data.memories;
  }

  async promote(userId?: string): Promise<Mem0PromoteResult> {
    return this.request<Mem0PromoteResult>("/memories/promote", {
      method: "POST",
      body: JSON.stringify({
        user_id: userId ?? this.defaultUserId,
      }),
    });
  }

  async getUserMemories(userId?: string, limit = 50): Promise<Mem0Memory[]> {
    const uid = userId ?? this.defaultUserId;
    const data = await this.request<{ memories: Mem0Memory[] }>(
      `/memories/user/${encodeURIComponent(uid)}?limit=${limit}`,
    );
    return data.memories;
  }

  async getAgentMemories(agentId?: string, limit = 50): Promise<Mem0Memory[]> {
    const aid = agentId ?? this.defaultAgentId;
    const data = await this.request<{ memories: Mem0Memory[] }>(
      `/memories/agent/${encodeURIComponent(aid)}?limit=${limit}`,
    );
    return data.memories;
  }

  async deleteMemory(memoryId: string): Promise<{ success: boolean; deleted: string }> {
    return this.request<{ success: boolean; deleted: string }>(
      `/memories/${encodeURIComponent(memoryId)}`,
      { method: "DELETE" },
    );
  }

  // ---- Profiles ----

  async getUserProfile(userId?: string): Promise<Mem0Profile> {
    const uid = userId ?? this.defaultUserId;
    return this.request<Mem0Profile>(`/profiles/user/${encodeURIComponent(uid)}`);
  }

  async updateUserProfile(
    profile: { display_name?: string; preferences?: Record<string, unknown> },
    userId?: string,
  ): Promise<{ success: boolean }> {
    const uid = userId ?? this.defaultUserId;
    return this.request<{ success: boolean }>(`/profiles/user/${encodeURIComponent(uid)}`, {
      method: "PUT",
      body: JSON.stringify(profile),
    });
  }

  async getAgentProfile(agentId?: string): Promise<Mem0Profile> {
    const aid = agentId ?? this.defaultAgentId;
    return this.request<Mem0Profile>(`/profiles/agent/${encodeURIComponent(aid)}`);
  }

  async updateAgentProfile(
    profile: { display_name?: string; personality?: string; private_notes?: string },
    agentId?: string,
  ): Promise<{ success: boolean }> {
    const aid = agentId ?? this.defaultAgentId;
    return this.request<{ success: boolean }>(`/profiles/agent/${encodeURIComponent(aid)}`, {
      method: "PUT",
      body: JSON.stringify(profile),
    });
  }

  // ---- Private HTTP helper ----

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(options?.headers as Record<string, string> | undefined),
      };
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `mem0-api ${options?.method ?? "GET"} ${path} failed: ${response.status} ${response.statusText}${body ? ` - ${body.slice(0, 200)}` : ""}`,
        );
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
