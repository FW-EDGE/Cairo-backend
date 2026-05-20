"""
agent/config.py — Unified configuration loader for the CAIRO agent

Secrets are read from the shared ../.env (same file used by the Node.js backend).
Non-secret settings (stt, tts, voice, agent prompt, etc.) are read from config.yaml.

All tools should use:
    from config import load_config
"""
import os
import sys
import yaml
from pathlib import Path
from dotenv import load_dotenv

# Load shared .env from backend-node root (one directory above agent/)
_ENV_PATH = Path(__file__).parent.parent / ".env"
load_dotenv(_ENV_PATH)

_YAML_PATH = Path(__file__).parent / "config.yaml"


def _req(name: str) -> str:
    """Return env var value or raise EnvironmentError if missing."""
    val = os.environ.get(name)
    if not val:
        raise EnvironmentError(
            f"Missing required environment variable: {name}\n"
            f"Expected in: {_ENV_PATH}"
        )
    return val


def _opt(name: str, default: str = "") -> str:
    """Return env var value or default if not set."""
    return os.environ.get(name) or default


def load_config() -> dict:
    """
    Return merged config dict combining secrets from .env and settings from config.yaml.
    Backward-compatible with the original yaml-only load_config() structure.
    """
    with open(_YAML_PATH, encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}

    # ── MongoDB (all from env) ─────────────────────────────────────────────────
    cfg["mongodb"] = {
        "uri":          _req("MONGODB_URI"),
        "database":     _opt("MONGODB_DATABASE", "batch"),
        "collection":   _opt("MONGODB_COLLECTION", "cairo_embeddings"),
        "vector_index": _opt("MONGODB_VECTOR_INDEX", "vector_index"),
    }

    # ── LLM (api keys from env, model/temperature from yaml) ──────────────────
    if "llm" not in cfg:
        cfg["llm"] = {}

    cfg["llm"]["provider"] = _opt("LLM_PROVIDER", cfg["llm"].get("provider", "openai"))

    if "openai" not in cfg["llm"]:
        cfg["llm"]["openai"] = {}
    cfg["llm"]["openai"]["api_key"] = _req("OPENAI_API_KEY")
    cfg["llm"]["openai"]["model"]   = _opt("OPENAI_MODEL", cfg["llm"]["openai"].get("model", "gpt-4o"))

    grok_key = _opt("GROK_API_KEY")
    if grok_key:
        if "grok" not in cfg["llm"]:
            cfg["llm"]["grok"] = {}
        cfg["llm"]["grok"]["api_key"]  = grok_key
        cfg["llm"]["grok"]["model"]    = _opt("GROK_MODEL",    cfg["llm"]["grok"].get("model",    "grok-beta"))
        cfg["llm"]["grok"]["base_url"] = _opt("GROK_BASE_URL", cfg["llm"]["grok"].get("base_url", "https://api.x.ai/v1"))

    # ── Jira (secrets from env, default_project from yaml) ────────────────────
    jira_server = _opt("JIRA_SERVER")
    if jira_server:
        existing_jira = cfg.get("jira") or {}
        cfg["jira"] = {
            **existing_jira,
            "server_url": jira_server,
            "email":      _opt("JIRA_EMAIL",      existing_jira.get("email",      "")),
            "api_token":  _opt("JIRA_API_TOKEN",  existing_jira.get("api_token",  "")),
        }

    # ── Taqtic (api_key from env, api_url from yaml) ──────────────────────────
    taqtic_key = _opt("TAQTIC_API_KEY")
    if taqtic_key:
        if "taqtic" not in cfg:
            cfg["taqtic"] = {}
        cfg["taqtic"]["api_key"] = taqtic_key

    return cfg
