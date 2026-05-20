"""
drive_to_obsidian.py — Exporta Google Drive completo a Markdown en Obsidian.

Mantiene la estructura de carpetas de Drive. Convierte:
  - Google Docs       → Markdown (via HTML)
  - Google Sheets     → Tabla Markdown
  - Google Slides     → Outline de texto
  - PDFs / txt / md   → Copia directa o extracción de texto
  - Otros             → Nota stub con metadata

Uso:
    python drive_to_obsidian.py --vault "D:/My Brain/Doomsday Vault/raw-sources"
    python drive_to_obsidian.py --vault "D:/My Brain/Doomsday Vault/raw-sources" --dry-run
    python drive_to_obsidian.py --vault "D:/My Brain/Doomsday Vault/raw-sources" --folder-id "ID_DE_CARPETA"
"""

import os
import io
import re
import csv
import sys
import argparse
from pathlib import Path
from datetime import datetime

# ── Auth & API ─────────────────────────────────────────────────
sys.path.insert(0, str(Path(__file__).parent))
from tools.drive_tool import get_google_creds
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

# ── Conversión HTML → Markdown ─────────────────────────────────
def _clean_html(raw: str) -> str:
    """Elimina bloques <style>, <script> y <head> antes de convertir."""
    raw = re.sub(r'<style[^>]*>.*?</style>', '', raw, flags=re.S | re.I)
    raw = re.sub(r'<script[^>]*>.*?</script>', '', raw, flags=re.S | re.I)
    raw = re.sub(r'<head[^>]*>.*?</head>', '', raw, flags=re.S | re.I)
    return raw

try:
    import html2text as _html2text_mod
    _h2t = _html2text_mod.HTML2Text()
    _h2t.ignore_links     = False
    _h2t.ignore_images    = True
    _h2t.body_width       = 0      # sin wrap forzado
    _h2t.unicode_snob     = True   # mantener unicode en vez de ASCII
    _h2t.decode_errors    = 'ignore'
    def html_to_md(raw: str) -> str:
        return _h2t.handle(_clean_html(raw)).strip()
except ImportError:
    import html as _html_mod
    def html_to_md(raw: str) -> str:
        raw = _clean_html(raw)
        raw = _html_mod.unescape(raw)
        raw = re.sub(r'<h([1-6])[^>]*>(.*?)</h\1>', lambda m: '\n' + '#' * int(m.group(1)) + ' ' + m.group(2) + '\n', raw, flags=re.S)
        raw = re.sub(r'<b[^>]*>(.*?)</b>', r'**\1**', raw, flags=re.S)
        raw = re.sub(r'<i[^>]*>(.*?)</i>', r'*\1*', raw, flags=re.S)
        raw = re.sub(r'<li[^>]*>(.*?)</li>', r'- \1\n', raw, flags=re.S)
        raw = re.sub(r'<br\s*/?>', '\n', raw)
        raw = re.sub(r'<[^>]+>', '', raw)
        return raw.strip()

# ── MIME: qué exportar y cómo ──────────────────────────────────
EXPORT_AS = {
    "application/vnd.google-apps.document":     "text/html",
    "application/vnd.google-apps.spreadsheet":  "text/csv",
    "application/vnd.google-apps.presentation": "text/plain",
}

SKIP_MIME = {
    "application/vnd.google-apps.folder",
    "application/vnd.google-apps.shortcut",
    "application/vnd.google-apps.map",
    "application/vnd.google-apps.form",
    "application/vnd.google-apps.script",
    "application/vnd.google-apps.site",
}

BINARY_MIME = {
    "image/", "video/", "audio/",
    "application/zip", "application/x-zip",
    "application/octet-stream",
}

STATS = {"converted": 0, "skipped": 0, "error": 0, "folders": 0}


# ── Helpers ────────────────────────────────────────────────────
def safe_name(name: str) -> str:
    """Convierte un nombre de Drive a un nombre de archivo seguro."""
    name = re.sub(r'[<>:"/\\|?*]', '-', name)
    name = name.strip('. ')
    return name or "sin-nombre"


def csv_to_md_table(csv_text: str) -> str:
    """Convierte CSV a tabla Markdown."""
    try:
        reader = csv.reader(csv_text.splitlines())
        rows = list(reader)
        if not rows:
            return ""
        header = rows[0]
        separator = ["---"] * len(header)
        lines = [
            "| " + " | ".join(header) + " |",
            "| " + " | ".join(separator) + " |",
        ]
        for row in rows[1:]:
            # Pad row if shorter than header
            while len(row) < len(header):
                row.append("")
            lines.append("| " + " | ".join(
                cell.replace("|", "\\|").replace("\n", " ") for cell in row
            ) + " |")
        return "\n".join(lines)
    except Exception:
        return csv_text


def build_frontmatter(name: str, mime: str, modified: str, drive_id: str, url: str) -> str:
    return (
        "---\n"
        f"title: \"{name}\"\n"
        f"source: google-drive\n"
        f"drive_id: \"{drive_id}\"\n"
        f"mime_type: \"{mime}\"\n"
        f"modified: \"{modified[:10]}\"\n"
        f"url: \"{url}\"\n"
        f"synced: \"{datetime.now().strftime('%Y-%m-%d')}\"\n"
        "---\n\n"
    )


def is_binary(mime: str) -> bool:
    return any(mime.startswith(b) for b in BINARY_MIME)


# ── Exportación de un archivo ──────────────────────────────────
def export_file(service, file_meta: dict) -> str | None:
    """Descarga y convierte un archivo de Drive a texto Markdown. Retorna None si hay que saltear."""
    mime = file_meta.get("mimeType", "")
    name = file_meta["name"]
    fid  = file_meta["id"]

    if mime in SKIP_MIME or is_binary(mime):
        return None

    export_mime = EXPORT_AS.get(mime)

    try:
        if export_mime:
            # Google Workspace → exportar
            request = service.files().export_media(fileId=fid, mimeType=export_mime)
            buf = io.BytesIO()
            dl = MediaIoBaseDownload(buf, request)
            done = False
            while not done:
                _, done = dl.next_chunk()
            raw = buf.getvalue().decode("utf-8", errors="replace")

            if export_mime == "text/html":
                return html_to_md(raw)
            elif export_mime == "text/csv":
                return csv_to_md_table(raw)
            else:
                return raw.strip()

        elif mime in ("text/plain", "text/markdown", "text/x-markdown"):
            # Texto plano → descargar directo
            request = service.files().get_media(fileId=fid)
            buf = io.BytesIO()
            dl = MediaIoBaseDownload(buf, request)
            done = False
            while not done:
                _, done = dl.next_chunk()
            return buf.getvalue().decode("utf-8", errors="replace").strip()

        else:
            # Tipo no soportado → nota stub
            return f"*Archivo no convertible: `{mime}`*\n\nDescargá el original desde Drive."

    except Exception as e:
        raise RuntimeError(f"Error exportando '{name}': {e}") from e


# ── Recorrido recursivo de Drive ───────────────────────────────
def process_folder(service, folder_id: str, vault_path: Path, drive_path: Path, dry_run: bool):
    """Recorre una carpeta de Drive y procesa todos sus archivos recursivamente."""
    page_token = None
    while True:
        resp = service.files().list(
            q=f"'{folder_id}' in parents and trashed=false",
            fields="nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink)",
            pageSize=100,
            pageToken=page_token,
        ).execute()

        for item in resp.get("files", []):
            mime     = item.get("mimeType", "")
            name     = item["name"]
            modified = item.get("modifiedTime", "")
            url      = item.get("webViewLink", "")

            if mime == "application/vnd.google-apps.folder":
                # Carpeta → recursión
                sub_drive = drive_path / safe_name(name)
                sub_vault = vault_path / safe_name(name)
                if not dry_run:
                    sub_vault.mkdir(parents=True, exist_ok=True)
                STATS["folders"] += 1
                print(f"  [DIR]  {sub_drive}/")
                process_folder(service, item["id"], sub_vault, sub_drive, dry_run)

            elif mime in SKIP_MIME or is_binary(mime):
                STATS["skipped"] += 1
                print(f"  [SKIP] {drive_path / name}  [{mime}]")

            else:
                out_name = safe_name(name)
                if not out_name.endswith(".md"):
                    out_name += ".md"
                out_path = vault_path / out_name

                # Si ya existe y es más nuevo que la modificación en Drive, saltear
                if out_path.exists() and not dry_run:
                    existing_mtime = datetime.fromtimestamp(out_path.stat().st_mtime)
                    drive_mtime    = datetime.fromisoformat(modified.replace("Z", "+00:00")).replace(tzinfo=None)
                    if existing_mtime >= drive_mtime:
                        STATS["skipped"] += 1
                        print(f"  ✓   {out_path.name}  (sin cambios)")
                        continue

                try:
                    content = export_file(service, item)
                    if content is None:
                        STATS["skipped"] += 1
                        continue

                    frontmatter = build_frontmatter(name, mime, modified, item["id"], url)
                    full_content = frontmatter + content

                    if dry_run:
                        print(f"  [DRY] {out_path}")
                    else:
                        vault_path.mkdir(parents=True, exist_ok=True)
                        out_path.write_text(full_content, encoding="utf-8")
                        print(f"  [OK]  {out_path.name}")

                    STATS["converted"] += 1

                except Exception as e:
                    STATS["error"] += 1
                    print(f"  [ERR] {name}: {e}")

        page_token = resp.get("nextPageToken")
        if not page_token:
            break


# ── Main ───────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Drive → Obsidian Markdown sync")
    parser.add_argument("--vault",     required=True, help="Path al vault de Obsidian")
    parser.add_argument("--folder-id", default="root", help="ID de carpeta raíz en Drive (default: raíz)")
    parser.add_argument("--dry-run",   action="store_true", help="Simulación sin escribir archivos")
    args = parser.parse_args()

    vault = Path(args.vault)
    if not args.dry_run:
        vault.mkdir(parents=True, exist_ok=True)

    print("=" * 60)
    print("  Drive -> Obsidian")
    print(f"  Vault:   {vault}")
    print(f"  Carpeta: {args.folder_id}")
    print(f"  Modo:    {'DRY RUN' if args.dry_run else 'REAL'}")
    print("=" * 60)

    print("\nConectando a Google Drive...")
    creds   = get_google_creds()
    service = build("drive", "v3", credentials=creds)

    # Nombre de la carpeta raíz
    if args.folder_id == "root":
        root_name = "Drive"
    else:
        meta = service.files().get(fileId=args.folder_id, fields="name").execute()
        root_name = meta.get("name", args.folder_id)

    print(f"Procesando '{root_name}'...\n")
    process_folder(service, args.folder_id, vault, Path(root_name), args.dry_run)

    print("\n" + "=" * 60)
    print(f"  Convertidos: {STATS['converted']}")
    print(f"  Salteados:   {STATS['skipped']}")
    print(f"  Carpetas:    {STATS['folders']}")
    print(f"  Errores:     {STATS['error']}")
    print("=" * 60)


if __name__ == "__main__":
    main()
