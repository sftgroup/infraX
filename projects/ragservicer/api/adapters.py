"""
LLM and Embedding adapters for InfraX Doc Service.
Factory functions that produce the callables LightRAG expects.
Supports local (SentenceTransformer) and cloud (DashScope) backends.
"""
import asyncio
import logging

from config import get_config

logger = logging.getLogger("ragservicer.adapters")

# ── Embedding model (lazy singleton, local backend) ──

_embed_model = None


def load_embedding_model():
    """Pre-load the embedding model. For local backend: SentenceTransformer.
       For cloud backends: no-op (API calls are stateless)."""
    cfg = get_config().embedding
    if cfg.backend != "local":
        logger.info(f"Embedding backend: {cfg.backend} (cloud, no preload needed)")
        return None

    global _embed_model
    from sentence_transformers import SentenceTransformer
    logger.info(f"Loading local embedding model: {cfg.model_name}...")
    _embed_model = SentenceTransformer(cfg.model_name)
    if hasattr(_embed_model, 'get_embedding_dimension'):
        dim = _embed_model.get_embedding_dimension()
    else:
        dim = _embed_model.get_sentence_embedding_dimension()
    logger.info(f"Embedding model loaded, dims={dim}")
    return _embed_model


def get_embed_model():
    global _embed_model
    if _embed_model is None:
        load_embedding_model()
    return _embed_model


# ── LightRAG-compatible function factories ───────────

def create_llm_func():
    """Return an async llm_model_func conforming to LightRAG's interface."""
    cfg = get_config().llm
    from lightrag.llm.openai import openai_complete_if_cache

    async def func(prompt, system_prompt=None, history_messages=None, **kwargs):
        if history_messages is None:
            history_messages = []
        return await openai_complete_if_cache(
            cfg.model, prompt,
            system_prompt=system_prompt,
            history_messages=history_messages,
            api_key=cfg.api_key,
            base_url=cfg.base_url,
            **kwargs,
        )
    return func


def _encode_local(texts: list[str]):
    """Encode texts using local SentenceTransformer model.
       Returns numpy array — LightRAG NanoVectorDB needs .size attribute."""
    return get_embed_model().encode(texts, normalize_embeddings=True)


def _encode_dashscope(texts: list[str], cfg):
    """Encode texts using DashScope embedding API (OpenAI-compatible).
       Returns numpy array — LightRAG NanoVectorDB needs .size attribute."""
    import requests
    import numpy as np
    resp = requests.post(
        f"{cfg.base_url}/embeddings",
        headers={
            "Authorization": f"Bearer {cfg.api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": cfg.model_name,
            "input": texts,
        },
        timeout=cfg.api_timeout,
    )
    resp.raise_for_status()
    data = resp.json()
    items = sorted(data["data"], key=lambda x: x["index"])
    return np.array([item["embedding"] for item in items])


def create_embedding_func():
    """Return an EmbeddingFunc. Backend selected by EMBEDDING_BACKEND env var."""
    cfg = get_config().embedding
    from lightrag.utils import EmbeddingFunc

    if cfg.backend == "dashscope":
        async def func(texts: list[str]):
            loop = asyncio.get_event_loop()
            return await loop.run_in_executor(None, _encode_dashscope, texts, cfg)

        return EmbeddingFunc(
            embedding_dim=cfg.dims,
            max_token_size=cfg.max_token_size,
            func=func,
        )

    # Default: local SentenceTransformer
    async def func(texts: list[str]):
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _encode_local, texts)

    return EmbeddingFunc(
        embedding_dim=cfg.dims,
        max_token_size=cfg.max_token_size,
        func=func,
    )
