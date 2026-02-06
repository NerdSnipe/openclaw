"""
mem0 REST API Server for OpenClaw Integration

Memory Architecture:
- Postgres: History, metadata, structured data (durable)
- Redis: Short-term/working memory (fast, ephemeral)
- Qdrant: Long-term vector memory (persistent embeddings)
- Neo4j: Graph memory (relationships between entities)

Flow:
1. New memories -> Redis (immediate, fast) + Postgres (history log)
2. Periodic promotion -> Qdrant + Neo4j (durable, searchable)
3. Search queries -> Qdrant/Neo4j with Redis boost for recency
4. Analytics/audit -> Postgres

LLM/Embedder Configuration (via environment variables):
- MEM0_LLM_PROVIDER: openai (default), google
- MEM0_LLM_MODEL: gpt-4o-mini (default), gemini-2.0-flash, etc.
- MEM0_EMBEDDER_PROVIDER: openai (default), ollama, google
- MEM0_EMBEDDER_MODEL: text-embedding-3-small (default), nomic-embed-text:v1.5, etc.
- MEM0_EMBEDDING_DIMS: 1536 (default, matches text-embedding-3-small)
"""

import os
import json
import time
import logging
from typing import Optional, List, Dict, Any
from datetime import datetime, timedelta
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel
import uvicorn
import redis
from sqlalchemy import create_engine, Column, String, DateTime, Text, Integer, JSON
from sqlalchemy.orm import declarative_base, sessionmaker

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mem0-api")

# mem0 imports
from mem0 import Memory

# Database setup
Base = declarative_base()

class MemoryHistory(Base):
    """Track all memory operations for audit/analytics."""
    __tablename__ = "memory_history"

    id = Column(Integer, primary_key=True, autoincrement=True)
    operation = Column(String(50))  # add, search, promote, delete
    user_id = Column(String(255), nullable=True)
    agent_id = Column(String(255), nullable=True)
    session_id = Column(String(255), nullable=True)
    content_hash = Column(String(64), nullable=True)
    memory_tier = Column(String(50))  # short_term, long_term, graph
    extra_data = Column(JSON, nullable=True)  # renamed from 'metadata' (reserved)
    created_at = Column(DateTime, default=datetime.utcnow)


class UserProfile(Base):
    """Store user preferences and context."""
    __tablename__ = "user_profiles"

    user_id = Column(String(255), primary_key=True)
    display_name = Column(String(255), nullable=True)
    preferences = Column(JSON, nullable=True)
    last_seen = Column(DateTime, default=datetime.utcnow)
    created_at = Column(DateTime, default=datetime.utcnow)


class AgentProfile(Base):
    """Store agent identity and private config."""
    __tablename__ = "agent_profiles"

    agent_id = Column(String(255), primary_key=True)
    display_name = Column(String(255), nullable=True)
    personality = Column(Text, nullable=True)
    private_notes = Column(Text, nullable=True)  # Agent's private thoughts
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


# Database connection
db_engine = None
DbSession = None

# Redis client for short-term memory
redis_client: Optional[redis.Redis] = None

# mem0 for long-term memory
memory: Optional[Memory] = None

# Constants
SHORT_TERM_TTL_HOURS = 24  # Keep in Redis for 24 hours
SHORT_TERM_PREFIX = "stm:"  # Short-term memory prefix
PROMOTION_THRESHOLD = 3  # Promote after accessed 3+ times

# Embedder health check cache (avoid generating embedding on every Docker healthcheck)
_embedder_cache: Dict[str, Any] = {"ok": None, "info": {}, "expires": 0.0}


def create_database():
    """Create Postgres connection and tables."""
    database_url = os.environ.get("DATABASE_URL", "postgresql://mem0:mem0password@localhost:5432/mem0")
    engine = create_engine(database_url)
    Base.metadata.create_all(engine)
    return engine, sessionmaker(bind=engine)


def create_redis_client():
    """Create Redis client for short-term memory."""
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")
    return redis.from_url(redis_url, decode_responses=True)


def log_operation(operation: str, user_id: str = None, agent_id: str = None,
                  session_id: str = None, content_hash: str = None,
                  memory_tier: str = None, extra_data: dict = None):
    """Log memory operation to Postgres for audit/analytics."""
    if not DbSession:
        return
    try:
        session = DbSession()
        entry = MemoryHistory(
            operation=operation,
            user_id=user_id,
            agent_id=agent_id,
            session_id=session_id,
            content_hash=content_hash,
            memory_tier=memory_tier,
            extra_data=extra_data,
        )
        session.add(entry)
        session.commit()
        session.close()
    except Exception as e:
        logger.error(f"Failed to log operation: {e}")


def build_mem0_config() -> dict:
    """Build mem0 config from environment variables."""
    llm_provider = os.environ.get("MEM0_LLM_PROVIDER", "openai")
    llm_model = os.environ.get("MEM0_LLM_MODEL", "gpt-4o-mini")
    embedder_provider = os.environ.get("MEM0_EMBEDDER_PROVIDER", "openai")
    embedder_model = os.environ.get("MEM0_EMBEDDER_MODEL", "text-embedding-3-small")
    embedding_dims = int(os.environ.get("MEM0_EMBEDDING_DIMS", "1536"))
    enable_graph = os.environ.get("MEM0_ENABLE_GRAPH", "false").lower() == "true"

    logger.info(f"LLM: provider={llm_provider}, model={llm_model}")
    logger.info(f"Embedder: provider={embedder_provider}, model={embedder_model}, dims={embedding_dims}")
    logger.info(f"Graph store: {'enabled' if enable_graph else 'disabled'}")

    # Build LLM config
    llm_config: Dict[str, Any] = {
        "model": llm_model,
        "temperature": 0,
    }
    if llm_provider == "openai":
        llm_config["api_key"] = os.environ.get("OPENAI_API_KEY")
    elif llm_provider == "google":
        llm_config["api_key"] = os.environ.get("GEMINI_API_KEY")

    # Build embedder config
    embedder_config: Dict[str, Any] = {
        "model": embedder_model,
    }
    if embedder_provider == "openai":
        embedder_config["api_key"] = os.environ.get("OPENAI_API_KEY")
    elif embedder_provider == "ollama":
        embedder_config["ollama_base_url"] = os.environ.get("OLLAMA_BASE_URL", "http://host.docker.internal:11434")
    elif embedder_provider == "google":
        embedder_config["api_key"] = os.environ.get("GEMINI_API_KEY")

    config = {
        "llm": {
            "provider": llm_provider,
            "config": llm_config,
        },
        "embedder": {
            "provider": embedder_provider,
            "config": embedder_config,
        },
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "collection_name": "openclaw_memories",
                "host": os.environ.get("QDRANT_HOST", "localhost"),
                "port": int(os.environ.get("QDRANT_PORT", 6333)),
                "embedding_model_dims": embedding_dims,
            },
        },
    }

    # Graph store is optional — adds ~21s per write due to additional LLM calls.
    # Enable with MEM0_ENABLE_GRAPH=true when entity relationships are needed.
    if enable_graph:
        config["graph_store"] = {
            "provider": "neo4j",
            "config": {
                "url": os.environ.get("NEO4J_URI", "bolt://localhost:7687"),
                "username": os.environ.get("NEO4J_USERNAME", "neo4j"),
                "password": os.environ.get("NEO4J_PASSWORD", "mem0password"),
            },
        }

    return config


def create_memory_instance():
    """Create mem0 instance with configurable providers."""
    config = build_mem0_config()
    return Memory.from_config(config)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize memory systems on startup."""
    global memory, redis_client, db_engine, DbSession

    logger.info("Initializing memory systems...")

    # Initialize Postgres (history, metadata)
    try:
        db_engine, DbSession = create_database()
        logger.info("Postgres connected (history, metadata)")
    except Exception as e:
        logger.warning(f"Postgres not available: {e}")
        db_engine = None
        DbSession = None

    # Initialize Redis (short-term memory)
    try:
        redis_client = create_redis_client()
        redis_client.ping()
        logger.info("Redis connected (short-term memory)")
    except Exception as e:
        logger.warning(f"Redis not available: {e}")
        redis_client = None

    # Initialize mem0 (long-term memory)
    try:
        memory = create_memory_instance()
        logger.info("mem0 initialized (long-term + graph memory)")
    except Exception as e:
        logger.error(f"Failed to initialize mem0: {e}")

    yield
    logger.info("Shutting down mem0 API server")


app = FastAPI(
    title="mem0 API for OpenClaw",
    description="Multi-tier memory system: Postgres (history) + Redis (short-term) + Qdrant (long-term) + Neo4j (graph)",
    version="1.2.0",
    lifespan=lifespan,
)


# Request/Response models
class Message(BaseModel):
    role: str
    content: str


class AddMemoryRequest(BaseModel):
    messages: List[Message]
    user_id: Optional[str] = None
    agent_id: Optional[str] = None
    session_id: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    short_term_only: bool = False  # If True, only store in Redis


class SearchRequest(BaseModel):
    query: str
    user_id: Optional[str] = None
    agent_id: Optional[str] = None
    session_id: Optional[str] = None
    limit: int = 10
    include_short_term: bool = True  # Include Redis results


class PromoteRequest(BaseModel):
    memory_ids: Optional[List[str]] = None  # Specific IDs, or None for all eligible
    user_id: Optional[str] = None
    agent_id: Optional[str] = None


class MemoryResponse(BaseModel):
    id: str
    memory: str
    user_id: Optional[str] = None
    agent_id: Optional[str] = None
    score: Optional[float] = None
    source: str = "long_term"  # "short_term" or "long_term"
    metadata: Optional[Dict[str, Any]] = None


# Short-term memory helpers
def store_short_term(key: str, data: Dict[str, Any], ttl_hours: int = SHORT_TERM_TTL_HOURS):
    """Store memory in Redis with TTL."""
    if not redis_client:
        return False
    try:
        full_key = f"{SHORT_TERM_PREFIX}{key}"
        data["created_at"] = datetime.utcnow().isoformat()
        data["access_count"] = 0
        redis_client.setex(full_key, timedelta(hours=ttl_hours), json.dumps(data))
        return True
    except Exception as e:
        logger.error(f"Redis store error: {e}")
        return False


def get_short_term(pattern: str) -> List[Dict[str, Any]]:
    """Get memories from Redis matching pattern."""
    if not redis_client:
        return []
    try:
        keys = redis_client.keys(f"{SHORT_TERM_PREFIX}{pattern}*")
        results = []
        for key in keys:
            data = redis_client.get(key)
            if data:
                parsed = json.loads(data)
                # Increment access count
                parsed["access_count"] = parsed.get("access_count", 0) + 1
                redis_client.set(key, json.dumps(parsed), keepttl=True)
                results.append(parsed)
        return results
    except Exception as e:
        logger.error(f"Redis get error: {e}")
        return []


def get_promotable_memories(user_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Get short-term memories that should be promoted to long-term."""
    if not redis_client:
        return []
    try:
        pattern = f"{SHORT_TERM_PREFIX}{user_id or '*'}:*"
        keys = redis_client.keys(pattern)
        promotable = []
        for key in keys:
            data = redis_client.get(key)
            if data:
                parsed = json.loads(data)
                if parsed.get("access_count", 0) >= PROMOTION_THRESHOLD:
                    parsed["redis_key"] = key
                    promotable.append(parsed)
        return promotable
    except Exception as e:
        logger.error(f"Redis promotion scan error: {e}")
        return []


# Endpoints
@app.get("/health")
async def health_check():
    """Health check endpoint."""
    postgres_ok = db_engine is not None
    redis_ok = False
    if redis_client:
        try:
            redis_client.ping()
            redis_ok = True
        except:
            pass

    # Test embedder (cached for 5 minutes to avoid slow healthchecks)
    now = time.time()
    if now < _embedder_cache["expires"]:
        embedder_ok = _embedder_cache["ok"]
        embedder_info = _embedder_cache["info"]
    else:
        embedder_ok = False
        embedder_info = {}
        if memory:
            try:
                test_vector = memory.embedding_model.embed("health check")
                if test_vector and len(test_vector) > 0:
                    embedder_ok = True
                    embedder_info = {"dims": len(test_vector)}
                else:
                    embedder_info = {"error": "returned empty vector"}
            except Exception as e:
                embedder_info = {"error": str(e)[:200]}
        _embedder_cache["ok"] = embedder_ok
        _embedder_cache["info"] = embedder_info
        _embedder_cache["expires"] = now + 300  # Cache for 5 minutes

    enable_graph = os.environ.get("MEM0_ENABLE_GRAPH", "false").lower() == "true"
    all_healthy = postgres_ok and redis_ok and memory and embedder_ok

    result = {
        "status": "healthy" if all_healthy else "degraded",
        "service": "mem0-api",
        "database": "connected" if postgres_ok else "unavailable",
        "short_term_memory": "connected" if redis_ok else "unavailable",
        "long_term_memory": "connected" if memory else "unavailable",
        "graph_memory": "connected" if (memory and enable_graph) else ("disabled" if not enable_graph else "unavailable"),
        "embedder": "connected" if embedder_ok else "unavailable",
        "embedder_details": embedder_info,
    }
    return result


@app.post("/memories/add")
async def add_memory(request: AddMemoryRequest, background_tasks: BackgroundTasks):
    """
    Add memories from a conversation.

    By default, stores in Redis first (fast), then background promotes to long-term.
    Set short_term_only=True to keep only in Redis (ephemeral working memory).
    """
    start_time = time.time()
    messages = [{"role": m.role, "content": m.content} for m in request.messages]

    # Log incoming request with our metadata (category, source, etc.)
    logger.info(f"Adding memory: user={request.user_id}, agent={request.agent_id}, metadata={request.metadata}")

    # Generate a unique key for this memory
    import hashlib
    content_hash = hashlib.md5(str(messages).encode()).hexdigest()[:8]
    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
    memory_key = f"{request.user_id or 'anon'}:{timestamp}:{content_hash}"

    # Store in short-term memory (Redis)
    short_term_data = {
        "messages": messages,
        "user_id": request.user_id,
        "agent_id": request.agent_id,
        "session_id": request.session_id,
        "metadata": request.metadata,
    }

    redis_stored = store_short_term(memory_key, short_term_data)

    # Log to Postgres
    if redis_stored:
        log_operation(
            operation="add",
            user_id=request.user_id,
            agent_id=request.agent_id,
            session_id=request.session_id,
            content_hash=content_hash,
            memory_tier="short_term",
            extra_data={"key": memory_key}
        )

    # If not short_term_only, also store in long-term
    long_term_result = None
    if not request.short_term_only and memory:
        try:
            long_term_result = memory.add(
                messages,
                user_id=request.user_id,
                agent_id=request.agent_id,
                run_id=request.session_id,
                metadata=request.metadata,
            )
            log_operation(
                operation="add",
                user_id=request.user_id,
                agent_id=request.agent_id,
                session_id=request.session_id,
                content_hash=content_hash,
                memory_tier="long_term",
                extra_data={"result": str(long_term_result)[:500]}
            )
        except Exception as e:
            error_msg = str(e)
            if "PointStruct" in error_msg or "vector" in error_msg.lower():
                logger.error(
                    "Long-term storage failed: embedder returned no vector. "
                    "Check your embedder config (provider, model, API key/Ollama URL). "
                    f"Detail: {e}"
                )
            else:
                logger.error(f"Long-term memory error: {e}")

    elapsed = time.time() - start_time
    logger.info(f"add_memory completed in {elapsed:.2f}s (short_term={redis_stored}, long_term={long_term_result is not None})")

    return {
        "success": True,
        "short_term": redis_stored,
        "long_term": long_term_result is not None,
        "memory_key": memory_key if redis_stored else None,
        "result": long_term_result,
    }


@app.post("/memories/search")
async def search_memories(request: SearchRequest):
    """
    Search memories across both short-term and long-term storage.

    Results are merged and ranked, with short-term memories boosted for recency.
    """
    start_time = time.time()
    results = []

    # Search short-term memory (Redis)
    if request.include_short_term and redis_client:
        pattern = request.user_id or "*"
        short_term = get_short_term(pattern)
        for stm in short_term:
            # Simple keyword matching for Redis (no vector search)
            query_lower = request.query.lower()
            messages = stm.get("messages", [])
            content = str(messages).lower()
            if query_lower in content or any(word in content for word in query_lower.split()):
                results.append(MemoryResponse(
                    id=f"stm:{stm.get('user_id', 'anon')}:{stm.get('created_at', '')}",
                    memory=format_messages_as_memory(messages),
                    user_id=stm.get("user_id"),
                    agent_id=stm.get("agent_id"),
                    score=0.8,  # Boost short-term
                    source="short_term",
                    metadata=stm.get("metadata"),
                ))

    # Search long-term memory (Qdrant + Neo4j)
    if memory:
        try:
            # mem0's search() requires user_id/agent_id/run_id as direct kwargs
            # (not inside a filters dict) — same pattern as memory.add().
            search_kwargs = {
                "query": request.query,
                "limit": request.limit,
            }
            if request.user_id:
                search_kwargs["user_id"] = request.user_id
            if request.agent_id:
                search_kwargs["agent_id"] = request.agent_id
            if request.session_id:
                search_kwargs["run_id"] = request.session_id

            long_term = memory.search(**search_kwargs)

            for r in long_term.get("results", []):
                results.append(MemoryResponse(
                    id=r.get("id", ""),
                    memory=r.get("memory", ""),
                    user_id=r.get("user_id"),
                    agent_id=r.get("agent_id"),
                    score=r.get("score"),
                    source="long_term",
                    metadata=r.get("metadata"),
                ))
        except Exception as e:
            logger.error(f"Long-term search error: {e}")

    # Sort by score descending
    results.sort(key=lambda x: x.score or 0, reverse=True)

    elapsed = time.time() - start_time
    final = results[:request.limit]
    short_count = sum(1 for r in final if r.source == "short_term")
    long_count = sum(1 for r in final if r.source == "long_term")
    logger.info(f"search completed in {elapsed:.2f}s (query={request.query!r:.50}, results={len(final)}, short={short_count}, long={long_count})")

    return {
        "memories": final,
        "count": len(final),
        "sources": {
            "short_term": short_count,
            "long_term": long_count,
        }
    }


@app.post("/memories/promote")
async def promote_memories(request: PromoteRequest):
    """
    Promote short-term memories to long-term storage.

    Called manually or by a scheduled job to move important memories
    from Redis to Qdrant + Neo4j.
    """
    if not memory:
        raise HTTPException(status_code=503, detail="Long-term memory not initialized")

    promotable = get_promotable_memories(request.user_id)
    promoted = []

    for mem in promotable:
        try:
            result = memory.add(
                mem.get("messages", []),
                user_id=mem.get("user_id"),
                agent_id=mem.get("agent_id"),
                run_id=mem.get("session_id"),
                metadata=mem.get("metadata"),
            )

            # Remove from Redis after successful promotion
            if redis_client and mem.get("redis_key"):
                redis_client.delete(mem["redis_key"])

            promoted.append({
                "original_key": mem.get("redis_key"),
                "result": result,
            })
        except Exception as e:
            logger.error(f"Promotion error for {mem.get('redis_key')}: {e}")

    return {
        "promoted_count": len(promoted),
        "promoted": promoted,
    }


def format_messages_as_memory(messages: list) -> str:
    """Format raw messages array into a readable memory string."""
    if not messages or not isinstance(messages, list):
        return str(messages)

    # Extract the key content from the conversation
    parts = []
    for msg in messages:
        if isinstance(msg, dict):
            role = msg.get("role", "")
            content = msg.get("content", "")
            if role == "user" and content:
                parts.append(f"User said: {content}")
            elif role == "assistant" and content:
                parts.append(f"Assistant said: {content}")

    if parts:
        return " | ".join(parts)

    # Fallback: just stringify
    return str(messages)


@app.get("/memories/user/{user_id}")
async def get_user_memories(user_id: str, limit: int = 50, include_short_term: bool = True):
    """Get all memories for a specific user from both tiers."""
    results = []

    # Short-term
    if include_short_term:
        short_term = get_short_term(user_id)
        for stm in short_term:
            messages = stm.get("messages", [])
            results.append({
                "id": f"stm:{user_id}:{stm.get('created_at', '')}",
                "memory": format_messages_as_memory(messages),
                "source": "short_term",
                "access_count": stm.get("access_count", 0),
                "created_at": stm.get("created_at"),
            })

    # Long-term
    if memory:
        try:
            long_term = memory.get_all(user_id=user_id, limit=limit)
            for ltm in long_term.get("results", []):
                results.append({
                    "id": ltm.get("id"),
                    "memory": ltm.get("memory"),
                    "source": "long_term",
                    **ltm,
                })
        except Exception as e:
            logger.error(f"Long-term get error: {e}")

    return {"memories": results, "user_id": user_id}


@app.get("/memories/agent/{agent_id}")
async def get_agent_memories(agent_id: str, limit: int = 50):
    """Get private agent memories (long-term only for privacy)."""
    if not memory:
        raise HTTPException(status_code=503, detail="Memory system not initialized")

    try:
        results = memory.get_all(agent_id=agent_id, limit=limit)
        return {"memories": results.get("results", []), "agent_id": agent_id}
    except Exception as e:
        logger.error(f"Error getting agent memories: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/memories/{memory_id}")
async def delete_memory(memory_id: str):
    """Delete a specific memory from long-term storage."""
    if not memory:
        raise HTTPException(status_code=503, detail="Memory system not initialized")

    try:
        memory.delete(memory_id)
        return {"success": True, "deleted": memory_id}
    except Exception as e:
        logger.error(f"Error deleting memory: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/stats")
async def get_stats():
    """Get memory system statistics."""
    stats = {
        "database": {"available": db_engine is not None, "history_count": 0},
        "short_term": {"available": redis_client is not None, "count": 0},
        "long_term": {"available": memory is not None},
    }

    if DbSession:
        try:
            session = DbSession()
            stats["database"]["history_count"] = session.query(MemoryHistory).count()
            session.close()
        except:
            pass

    if redis_client:
        try:
            keys = redis_client.keys(f"{SHORT_TERM_PREFIX}*")
            stats["short_term"]["count"] = len(keys)
        except:
            pass

    return stats


# Profile management endpoints
class UserProfileRequest(BaseModel):
    display_name: Optional[str] = None
    preferences: Optional[Dict[str, Any]] = None


class AgentProfileRequest(BaseModel):
    display_name: Optional[str] = None
    personality: Optional[str] = None
    private_notes: Optional[str] = None


@app.get("/profiles/user/{user_id}")
async def get_user_profile(user_id: str):
    """Get user profile."""
    if not DbSession:
        raise HTTPException(status_code=503, detail="Database not available")

    session = DbSession()
    profile = session.query(UserProfile).filter_by(user_id=user_id).first()
    session.close()

    if not profile:
        return {"user_id": user_id, "exists": False}

    return {
        "user_id": profile.user_id,
        "display_name": profile.display_name,
        "preferences": profile.preferences,
        "last_seen": profile.last_seen.isoformat() if profile.last_seen else None,
        "created_at": profile.created_at.isoformat() if profile.created_at else None,
        "exists": True,
    }


@app.put("/profiles/user/{user_id}")
async def update_user_profile(user_id: str, request: UserProfileRequest):
    """Create or update user profile."""
    if not DbSession:
        raise HTTPException(status_code=503, detail="Database not available")

    session = DbSession()
    profile = session.query(UserProfile).filter_by(user_id=user_id).first()

    if not profile:
        profile = UserProfile(user_id=user_id)
        session.add(profile)

    if request.display_name is not None:
        profile.display_name = request.display_name
    if request.preferences is not None:
        profile.preferences = request.preferences
    profile.last_seen = datetime.utcnow()

    session.commit()
    session.close()

    return {"success": True, "user_id": user_id}


@app.get("/profiles/agent/{agent_id}")
async def get_agent_profile(agent_id: str):
    """Get agent profile (including private notes for the agent itself)."""
    if not DbSession:
        raise HTTPException(status_code=503, detail="Database not available")

    session = DbSession()
    profile = session.query(AgentProfile).filter_by(agent_id=agent_id).first()
    session.close()

    if not profile:
        return {"agent_id": agent_id, "exists": False}

    return {
        "agent_id": profile.agent_id,
        "display_name": profile.display_name,
        "personality": profile.personality,
        "private_notes": profile.private_notes,
        "created_at": profile.created_at.isoformat() if profile.created_at else None,
        "updated_at": profile.updated_at.isoformat() if profile.updated_at else None,
        "exists": True,
    }


@app.put("/profiles/agent/{agent_id}")
async def update_agent_profile(agent_id: str, request: AgentProfileRequest):
    """Create or update agent profile."""
    if not DbSession:
        raise HTTPException(status_code=503, detail="Database not available")

    session = DbSession()
    profile = session.query(AgentProfile).filter_by(agent_id=agent_id).first()

    if not profile:
        profile = AgentProfile(agent_id=agent_id)
        session.add(profile)

    if request.display_name is not None:
        profile.display_name = request.display_name
    if request.personality is not None:
        profile.personality = request.personality
    if request.private_notes is not None:
        profile.private_notes = request.private_notes

    session.commit()
    session.close()

    return {"success": True, "agent_id": agent_id}


@app.get("/history")
async def get_history(user_id: Optional[str] = None, agent_id: Optional[str] = None,
                      operation: Optional[str] = None, limit: int = 100):
    """Get memory operation history (audit log)."""
    if not DbSession:
        raise HTTPException(status_code=503, detail="Database not available")

    session = DbSession()
    query = session.query(MemoryHistory)

    if user_id:
        query = query.filter(MemoryHistory.user_id == user_id)
    if agent_id:
        query = query.filter(MemoryHistory.agent_id == agent_id)
    if operation:
        query = query.filter(MemoryHistory.operation == operation)

    entries = query.order_by(MemoryHistory.created_at.desc()).limit(limit).all()
    session.close()

    return {
        "history": [
            {
                "id": e.id,
                "operation": e.operation,
                "user_id": e.user_id,
                "agent_id": e.agent_id,
                "session_id": e.session_id,
                "memory_tier": e.memory_tier,
                "created_at": e.created_at.isoformat() if e.created_at else None,
            }
            for e in entries
        ],
        "count": len(entries),
    }


if __name__ == "__main__":
    port = int(os.environ.get("MEM0_API_PORT", 8080))
    host = os.environ.get("MEM0_API_HOST", "0.0.0.0")

    logger.info(f"Starting mem0 API server on {host}:{port}")
    uvicorn.run(app, host=host, port=port)
