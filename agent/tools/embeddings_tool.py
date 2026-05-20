"""
tools/embeddings_tool.py — Indexación semántica y búsqueda vectorial para CAIRO
Fuentes: Google Drive (contenido + metadata), Jira, Gmail
Store:   MongoDB Atlas con Vector Search (text-embedding-3-small, 1536 dims)
"""
import io
import json
import sys
import time
from pathlib import Path

# Ensure agent root is in path so 'config' module is importable when run standalone
sys.path.insert(0, str(Path(__file__).parent.parent))
from config import load_config
from langchain.tools import tool

DRIVE_CACHE = Path(__file__).parent.parent / "cache" / "drive_tree.json"

EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIMS  = 1536

# Contenido: tamaño de cada chunk y límite por archivo
CHUNK_WORDS = 400
MAX_CHARS   = 20_000   # ~5 páginas; evita archivos enormes

# Tipos de Drive que se pueden exportar como texto plano
_TEXT_TYPES = {"doc", "sheet", "slide"}


# ── Helpers de configuración ──────────────────────────────────────────────────

def _load_config() -> dict:
    return load_config()


def _get_mongo_collection():
    from pymongo import MongoClient
    cfg    = _load_config()["mongodb"]
    client = MongoClient(
        cfg["uri"],
        tlsAllowInvalidCertificates=True,
        retryWrites=True,
        serverSelectionTimeoutMS=10_000,
    )
    return client[cfg["database"]][cfg["collection"]]


def _get_openai_client():
    from openai import OpenAI
    cfg = _load_config()
    return OpenAI(api_key=cfg["llm"]["openai"]["api_key"])


def _embed_batch(client, texts: list[str]) -> list[list[float]]:
    """Genera embeddings en lotes de 100 con pausa entre lotes para no saturar rate limit."""
    vectors = []
    BATCH = 100
    for i in range(0, len(texts), BATCH):
        chunk = texts[i : i + BATCH]
        resp  = client.embeddings.create(model=EMBEDDING_MODEL, input=chunk)
        vectors.extend([r.embedding for r in resp.data])
        if i + BATCH < len(texts):
            time.sleep(0.2)
    return vectors


# ── Helpers de contenido ──────────────────────────────────────────────────────

def _get_drive_service():
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build
    cfg        = _load_config()["google"]
    root       = Path(__file__).parent.parent
    token_path = root / cfg["token_file"]
    creds = Credentials.from_authorized_user_file(str(token_path), cfg["scopes"])
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
    return build("drive", "v3", credentials=creds)


def _export_text(service, file_id: str) -> str:
    """Exporta un Google Doc/Sheet/Slide como texto plano."""
    try:
        raw = service.files().export(fileId=file_id, mimeType="text/plain").execute()
        text = raw.decode("utf-8", errors="ignore") if isinstance(raw, bytes) else str(raw)
        return text[:MAX_CHARS]
    except Exception:
        return ""


def _pdf_text(service, file_id: str) -> str:
    """Descarga un PDF y extrae su texto con pypdf."""
    try:
        from pypdf import PdfReader
        raw    = service.files().get_media(fileId=file_id).execute()
        reader = PdfReader(io.BytesIO(raw))
        text   = ""
        for page in reader.pages:
            text += page.extract_text() or ""
            if len(text) >= MAX_CHARS:
                break
        return text[:MAX_CHARS]
    except Exception:
        return ""


def _fetch_content(service, file_id: str, ftype: str) -> str:
    """Devuelve el texto del archivo según su tipo. Vacío si no aplica."""
    if ftype in _TEXT_TYPES:
        return _export_text(service, file_id)
    if ftype == "pdf":
        return _pdf_text(service, file_id)
    return ""


def _chunks(text: str) -> list[str]:
    """Divide texto en chunks de CHUNK_WORDS palabras."""
    words  = text.split()
    result = []
    for i in range(0, len(words), CHUNK_WORDS):
        chunk = " ".join(words[i : i + CHUNK_WORDS]).strip()
        if chunk:
            result.append(chunk)
    return result or [""]


# ── Indexador de Drive ────────────────────────────────────────────────────────

def _build_path_map(all_files: list[dict]) -> dict[str, str]:
    """Construye mapa file_id → ruta completa (ej: 'Globaltask/Calidad/Casos de éxito')."""
    by_id     = {f["id"]: f for f in all_files if f.get("id")}
    parent_of = {}
    for f in all_files:
        parents = f.get("parents", [])
        if parents:
            parent_of[f["id"]] = parents[0]

    def get_path(fid: str, depth: int = 0) -> str:
        if depth > 12:
            return ""
        f = by_id.get(fid)
        if not f:
            return ""
        pid = parent_of.get(fid, "")
        if pid in ("root", "__shared__", ""):
            return f["name"]
        parent_path = get_path(pid, depth + 1)
        return f"{parent_path}/{f['name']}" if parent_path else f["name"]

    return {fid: get_path(fid) for fid in by_id}


def index_drive(verbose: bool = True) -> int:
    if not DRIVE_CACHE.exists():
        print("[Indexer] No hay cache de Drive — ejecutá el crawler primero.")
        return 0

    oai     = _get_openai_client()
    col     = _get_mongo_collection()
    service = _get_drive_service()

    data          = json.loads(DRIVE_CACHE.read_text(encoding="utf-8"))
    mydrive_files = data.get("mydrive", [])
    shared_files  = data.get("shared", [])
    all_files     = mydrive_files + shared_files
    path_map      = _build_path_map(all_files)

    docs  = []
    texts = []
    total_files = sum(1 for s in [mydrive_files, shared_files] for f in s if f.get("id") and f.get("name"))

    processed = 0
    for section, files in [("mydrive", mydrive_files), ("shared", shared_files)]:
        for f in files:
            if not f.get("id") or not f.get("name"):
                continue

            name   = f["name"]
            ftype  = f.get("type", "file")
            path   = path_map.get(f["id"], name)
            url    = f.get("url", "")
            header = f"[{ftype}] {name}\nRuta: {path}"

            # Intentar obtener contenido del archivo
            content_text = _fetch_content(service, f["id"], ftype)

            if content_text.strip():
                # Crear un doc por cada chunk de contenido
                for i, chunk in enumerate(_chunks(content_text)):
                    embed_text = f"{header}\n\n{chunk}"
                    texts.append(embed_text)
                    docs.append({
                        "source":      "drive",
                        "section":     section,
                        "type":        ftype,
                        "name":        name,
                        "url":         url,
                        "content":     embed_text,
                        "path":        path,
                        "chunk_index": i,
                    })
            else:
                # Sin contenido exportable — solo metadata
                texts.append(header)
                docs.append({
                    "source":      "drive",
                    "section":     section,
                    "type":        ftype,
                    "name":        name,
                    "url":         url,
                    "content":     header,
                    "path":        path,
                    "chunk_index": -1,
                })

            processed += 1
            if verbose and processed % 100 == 0:
                print(f"[Indexer] Drive: {processed}/{total_files} archivos procesados, {len(docs)} chunks generados...")

            # Pausa leve para no saturar la Drive API
            if ftype in _TEXT_TYPES or ftype == "pdf":
                time.sleep(0.05)

    if not docs:
        return 0

    if verbose:
        print(f"[Indexer] Drive: generando embeddings para {len(docs)} chunks...")
    vectors = _embed_batch(oai, texts)

    for doc, vec in zip(docs, vectors):
        doc["vector"] = vec

    col.delete_many({"source": "drive"})
    col.insert_many(docs)
    if verbose:
        print(f"[Indexer] Drive: {len(docs)} chunks de {total_files} archivos indexados.")
    return len(docs)


# ── Indexador de Jira ─────────────────────────────────────────────────────────

def _extract_adf_text(node, depth: int = 0) -> str:
    """Extrae texto plano de Atlassian Document Format (ADF)."""
    if depth > 6 or not isinstance(node, dict):
        return ""
    if node.get("type") == "text":
        return node.get("text", "")
    parts = [_extract_adf_text(child, depth + 1) for child in node.get("content", [])]
    return " ".join(p for p in parts if p)


def index_jira(verbose: bool = True) -> int:
    import requests as req
    cfg  = _load_config()["jira"]
    auth = (cfg["email"], cfg["api_token"])
    url  = cfg["server_url"].rstrip("/") + "/rest/api/3/search/jql"

    oai = _get_openai_client()
    col = _get_mongo_collection()

    docs     = []
    texts    = []
    start_at = 0

    while True:
        resp = req.get(url, auth=auth, params={
            "jql":        "project IS NOT EMPTY ORDER BY updated DESC",
            "maxResults": 100,
            "startAt":    start_at,
            "fields":     "summary,status,priority,description,assignee,issuetype,project,parent",
        }, timeout=15)
        data   = resp.json()
        issues = data.get("issues", [])
        if not issues:
            break

        for issue in issues:
            f        = issue["fields"]
            key      = issue["key"]
            summary  = f.get("summary", "")
            status   = (f.get("status") or {}).get("name", "")
            priority = (f.get("priority") or {}).get("name", "")
            itype    = (f.get("issuetype") or {}).get("name", "")
            project  = (f.get("project") or {}).get("name", "")

            desc_raw = f.get("description") or ""
            desc     = _extract_adf_text(desc_raw)[:400] if isinstance(desc_raw, dict) else str(desc_raw)[:400]

            jira_url = cfg["server_url"].rstrip("/") + f"/browse/{key}"
            text     = f"[{key}] {summary}\nProyecto: {project} | Tipo: {itype} | Estado: {status} | Prioridad: {priority}"
            if desc.strip():
                text += f"\n{desc}"

            texts.append(text)
            docs.append({
                "source":  "jira",
                "type":    itype,
                "name":    f"{key}: {summary}",
                "url":     jira_url,
                "content": text,
                "key":     key,
                "status":  status,
                "project": project,
            })

        start_at += len(issues)
        if start_at >= data.get("total", 0):
            break

    if not docs:
        return 0

    if verbose:
        print(f"[Indexer] Jira: generando embeddings para {len(docs)} tickets...")
    vectors = _embed_batch(oai, texts)
    for doc, vec in zip(docs, vectors):
        doc["vector"] = vec

    col.delete_many({"source": "jira"})
    col.insert_many(docs)
    if verbose:
        print(f"[Indexer] Jira: {len(docs)} tickets indexados.")
    return len(docs)


# ── Indexador de Gmail ────────────────────────────────────────────────────────

def index_gmail(max_emails: int = 500, verbose: bool = True) -> int:
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build

    cfg        = _load_config()["google"]
    root       = Path(__file__).parent.parent
    token_path = root / cfg["token_file"]

    if not token_path.exists():
        print("[Indexer] No hay token de Gmail.")
        return 0

    creds = Credentials.from_authorized_user_file(str(token_path), cfg["scopes"])
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())

    service    = build("gmail", "v1", credentials=creds)
    oai        = _get_openai_client()
    col        = _get_mongo_collection()
    docs       = []
    texts      = []
    page_token = None
    fetched    = 0

    while fetched < max_emails:
        params = {"userId": "me", "maxResults": min(100, max_emails - fetched)}
        if page_token:
            params["pageToken"] = page_token

        result   = service.users().messages().list(**params).execute()
        messages = result.get("messages", [])
        if not messages:
            break

        for msg in messages:
            detail  = service.users().messages().get(
                userId="me", id=msg["id"],
                format="metadata",
                metadataHeaders=["Subject", "From", "Date"],
            ).execute()
            headers = {h["name"]: h["value"] for h in detail.get("payload", {}).get("headers", [])}
            subject = headers.get("Subject", "(sin asunto)")
            from_   = headers.get("From", "")
            date_   = headers.get("Date", "")
            snippet = detail.get("snippet", "")[:300]
            mail_url = f"https://mail.google.com/mail/u/0/#inbox/{msg['id']}"

            text = f"Asunto: {subject}\nDe: {from_}\nFecha: {date_}\nResumen: {snippet}"
            texts.append(text)
            docs.append({
                "source":  "gmail",
                "type":    "mail-message",
                "name":    subject,
                "url":     mail_url,
                "content": text,
                "from":    from_,
                "date":    date_,
                "mail_id": msg["id"],
            })

        fetched   += len(messages)
        page_token = result.get("nextPageToken")
        if not page_token:
            break

    if not docs:
        return 0

    if verbose:
        print(f"[Indexer] Gmail: generando embeddings para {len(docs)} mails...")
    vectors = _embed_batch(oai, texts)
    for doc, vec in zip(docs, vectors):
        doc["vector"] = vec

    col.delete_many({"source": "gmail"})
    col.insert_many(docs)
    if verbose:
        print(f"[Indexer] Gmail: {len(docs)} mails indexados.")
    return len(docs)


# ── Indexación completa ───────────────────────────────────────────────────────

def run_full_index() -> dict:
    print("[Indexer] === Indexacion completa iniciada ===")
    n_drive = index_drive()
    n_jira  = index_jira()
    n_gmail = index_gmail()
    total   = n_drive + n_jira + n_gmail
    print(f"[Indexer] === Total: {total} items en MongoDB ===")
    return {"drive": n_drive, "jira": n_jira, "gmail": n_gmail, "total": total}


# ── Tool de búsqueda semántica ────────────────────────────────────────────────

@tool
def buscar_semantico(consulta: str, fuente: str = "") -> str:
    """
    Búsqueda semántica en Drive, Jira y Gmail usando embeddings vectoriales.
    Mucho más preciso que buscar por nombre exacto — entiende sinónimos y contexto.
    Usar cuando el usuario pida buscar archivos, tickets o mails por tema o contenido.
    Para resaltar en el mapa, usar los resultados con resaltar_archivos_en_mapa.
    consulta: descripción en lenguaje natural de lo que busca el usuario
    fuente: filtrar por origen — 'drive', 'jira', 'gmail' — o vacío para buscar en todo
    """
    try:
        oai       = _get_openai_client()
        resp      = oai.embeddings.create(model=EMBEDDING_MODEL, input=[consulta])
        query_vec = resp.data[0].embedding

        cfg = _load_config()["mongodb"]
        col = _get_mongo_collection()

        pipeline: list = [
            {
                "$vectorSearch": {
                    "index":         cfg["vector_index"],
                    "path":          "vector",
                    "queryVector":   query_vec,
                    "numCandidates": 300,
                    "limit":         60,   # más candidatos para compensar deduplicación
                }
            },
            {
                "$project": {
                    "source": 1, "section": 1, "type": 1, "name": 1, "url": 1,
                    "score":  {"$meta": "vectorSearchScore"},
                    "_id":    0,
                }
            },
        ]

        if fuente:
            pipeline[0]["$vectorSearch"]["filter"] = {"source": fuente}

        raw = list(col.aggregate(pipeline))

        if not raw:
            return f"No encontré resultados para: {consulta}"

        # Deduplicar: un archivo puede tener varios chunks — quedarse con el de mayor score
        seen: dict[str, dict] = {}
        for r in raw:
            key = f"{r['source']}::{r['name']}::{r.get('url','')}"
            if key not in seen or r["score"] > seen[key]["score"]:
                seen[key] = r

        results = sorted(seen.values(), key=lambda x: x["score"], reverse=True)[:20]

        lines = [f"Resultados para '{consulta}' ({len(results)} encontrados):"]
        for i, r in enumerate(results, 1):
            score   = r.get("score", 0)
            src     = r["source"].upper()
            section = f"/{r['section']}" if r.get("section") else ""
            lines.append(f"{i}. [{src}{section}] {r['name']}  ({score:.2f})")

        return "\n".join(lines)

    except Exception as e:
        return f"Error en búsqueda semántica: {e}"


# ── Entry point para correr el indexador directamente ─────────────────────────

if __name__ == "__main__":
    run_full_index()
