"""
tools/drive_tool.py — Herramienta Google Drive para el agente
El árbol completo se inyecta en el contexto del LLM desde agent.py.
Estas tools solo se usan para ACTUAR sobre archivos (mostrar, listar recientes).
"""
import json
import requests as req
from pathlib import Path
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from langchain.tools import tool

from config import load_config

DASHBOARD_URL = "http://localhost:7777"

# Stop words que no aportan valor a una búsqueda en Drive
_STOP_WORDS = {
    "de", "del", "al", "el", "la", "los", "las", "un", "una", "unos", "unas",
    "en", "con", "por", "para", "a", "e", "i", "u", "o", "y", "que", "se",
    "le", "les", "me", "te", "nos", "su", "sus", "mi", "mis", "tu", "tus",
    "este", "esta", "estos", "estas", "ese", "esa", "esos", "esas",
    "todo", "toda", "todos", "todas",
    # verbos típicos de una instrucción
    "busca", "buscame", "buscar", "encuentra", "encontrar", "muestra",
    "mostrar", "dame", "trae", "traeme", "listame", "listar",
    # genéricos de archivos
    "archivo", "archivos", "documento", "documentos", "carpeta", "carpetas",
    "archivo", "los", "mis",
}

def _keywords(consulta: str) -> list[str]:
    """Extrae palabras clave eliminando stop words y palabras muy cortas."""
    words = consulta.replace(",", " ").replace(";", " ").split()
    return [w for w in words if w.lower() not in _STOP_WORDS and len(w) >= 3]


def get_google_creds():
    root = Path(__file__).parent.parent
    cfg = load_config()["google"]
    creds = None
    token_path = root / cfg["token_file"]
    creds_path = root / cfg["credentials_file"]
    scopes = cfg["scopes"]

    if token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), scopes)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(str(creds_path), scopes)
            creds = flow.run_local_server(port=0)
        token_path.parent.mkdir(parents=True, exist_ok=True)
        token_path.write_text(creds.to_json())

    return creds


TYPE_TO_MIME = {
    "folder": "application/vnd.google-apps.folder",
    "doc":    "application/vnd.google-apps.document",
    "sheet":  "application/vnd.google-apps.spreadsheet",
    "slide":  "application/vnd.google-apps.presentation",
    "pdf":    "application/pdf",
}


def _buscar_archivo(service, nombre: str, tipo: str = "", file_id: str = "") -> dict | None:
    """
    Busca un archivo en Drive por ID directo (preferido) o por nombre.
    Si se pasa `tipo` (folder/doc/sheet/slide/pdf/image) filtra por mimeType.
    Retorna el primer resultado con id, name, mimeType, webViewLink, o None.
    """
    # Lookup directo por ID — nunca falla por nombres especiales
    if file_id:
        try:
            return service.files().get(
                fileId=file_id,
                fields="id, name, mimeType, webViewLink",
            ).execute()
        except Exception:
            pass  # fallback a búsqueda por nombre

    mime_filter = ""
    if tipo and tipo in TYPE_TO_MIME:
        mime_filter = f" and mimeType = '{TYPE_TO_MIME[tipo]}'"
    elif tipo == "image":
        mime_filter = " and mimeType contains 'image/'"

    # Escapar comillas simples para no romper la query
    nombre_esc = nombre.replace("'", "\\'")
    for name_q in [
        f"name = '{nombre_esc}'",
        f"name contains '{nombre_esc}'",
    ]:
        query = f"{name_q} and trashed = false{mime_filter}"
        resp  = service.files().list(
            q=query,
            pageSize=5,
            fields="files(id, name, mimeType, webViewLink)",
        ).execute()
        files = resp.get("files", [])
        if files:
            return files[0]
    return None


def _mime_to_type(mime: str) -> str:
    if "folder"       in mime: return "folder"
    if "document"     in mime: return "doc"
    if "spreadsheet"  in mime: return "sheet"
    if "presentation" in mime: return "slide"
    if "pdf"          in mime: return "pdf"
    if "image"        in mime: return "image"
    return "file"


@tool
def mostrar_archivo_drive(nombre: str, tipo: str = "") -> str:
    """
    Busca un archivo o carpeta en Google Drive por nombre y lo muestra en el mapa/dashboard.
    Usar cuando el usuario pida: mostrar en el mapa, ver en el mapa, abrir en el mapa,
    mostrar en el dashboard, o cualquier variante. El 'mapa' ES el dashboard de CAIRO.
    nombre: nombre exacto o parcial del archivo o carpeta (sin barra al final)
    tipo: tipo del archivo para desambiguar cuando hay varios con el mismo nombre.
          Valores: folder, doc, sheet, slide, pdf, image, file
          Inferirlo del árbol de Drive: carpetas terminan en '/', archivos tienen [doc], [xls], etc.
    """
    try:
        # Limpiar barra final que puede venir del árbol compacto (carpetas terminan en '/')
        nombre = nombre.rstrip("/").strip()

        creds   = get_google_creds()
        service = build("drive", "v3", credentials=creds)

        # Mapear abreviaciones del árbol compacto al tipo canónico
        ABBR_MAP = {"xls": "sheet", "ppt": "slide", "img": "image"}
        tipo_norm = ABBR_MAP.get(tipo, tipo)

        archivo = _buscar_archivo(service, nombre, tipo_norm)
        if not archivo:
            # Reintentar sin filtro de tipo si no encontró nada
            archivo = _buscar_archivo(service, nombre)
        if not archivo:
            return f"No encontré ningún archivo o carpeta llamado '{nombre}' en Drive."

        real_url  = archivo.get("webViewLink", "")
        real_name = archivo.get("name", nombre)
        file_type = _mime_to_type(archivo.get("mimeType", ""))

        req.post(
            f"{DASHBOARD_URL}/cairo/show",
            json={"name": real_name, "url": real_url, "file_type": file_type},
            timeout=3,
        )
        return f"Mostrando '{real_name}' en el dashboard."
    except Exception as e:
        return f"Error al mostrar '{nombre}': {e}"


@tool
def leer_archivo_drive(nombre: str, tipo: str = "") -> str:
    """
    Lee el contenido de un archivo de Google Drive.
    Funciona con Google Docs, Sheets (como CSV) y archivos de texto plano.
    Usar cuando el usuario pida leer, ver el contenido, o resumir un archivo.
    nombre: nombre exacto o parcial del archivo
    tipo: tipo del archivo para desambiguar (doc, sheet, slide, pdf, file).
          Inferirlo del árbol de Drive si hay varios archivos con el mismo nombre.
    """
    try:
        nombre = nombre.rstrip("/").strip()
        creds   = get_google_creds()
        service = build("drive", "v3", credentials=creds)

        ABBR_MAP = {"xls": "sheet", "ppt": "slide", "img": "image"}
        tipo_norm = ABBR_MAP.get(tipo, tipo)
        archivo = _buscar_archivo(service, nombre, tipo_norm)
        if not archivo:
            archivo = _buscar_archivo(service, nombre)
        if not archivo:
            return f"No encontré ningún archivo llamado '{nombre}' en Drive."

        file_id   = archivo["id"]
        file_name = archivo["name"]
        mime      = archivo.get("mimeType", "")

        EXPORT_MAP = {
            "application/vnd.google-apps.document":     "text/plain",
            "application/vnd.google-apps.spreadsheet":  "text/csv",
            "application/vnd.google-apps.presentation": "text/plain",
        }

        if mime in EXPORT_MAP:
            data      = service.files().export(fileId=file_id, mimeType=EXPORT_MAP[mime]).execute()
            contenido = data.decode("utf-8") if isinstance(data, bytes) else str(data)
        elif mime.startswith("text/"):
            from googleapiclient.http import MediaIoBaseDownload
            import io
            fh         = io.BytesIO()
            downloader = MediaIoBaseDownload(fh, service.files().get_media(fileId=file_id))
            done       = False
            while not done:
                _, done = downloader.next_chunk()
            contenido = fh.getvalue().decode("utf-8", errors="replace")
        else:
            return f"'{file_name}' es de tipo {mime.split('.')[-1]}. Solo puedo leer documentos de texto, Docs y Sheets."

        MAX = 6000
        nota = f"\n[... truncado a {MAX} caracteres]" if len(contenido) > MAX else ""
        return f"Contenido de '{file_name}':\n\n{contenido[:MAX].strip()}{nota}"

    except Exception as e:
        return f"Error al leer '{nombre}': {e}"


@tool
def crear_documento_drive(titulo: str, contenido: str = "", carpeta: str = "") -> str:
    """
    Crea un nuevo Google Doc en Drive.
    Usar cuando el usuario quiera crear un documento, nota, borrador o informe.
    titulo: nombre del documento
    contenido: texto inicial (opcional)
    carpeta: nombre de la carpeta donde guardarlo (opcional)
    """
    try:
        creds         = get_google_creds()
        docs_service  = build("docs",  "v1", credentials=creds)
        drive_service = build("drive", "v3", credentials=creds)

        doc    = docs_service.documents().create(body={"title": titulo}).execute()
        doc_id = doc["documentId"]

        if contenido.strip():
            docs_service.documents().batchUpdate(
                documentId=doc_id,
                body={"requests": [{"insertText": {"location": {"index": 1}, "text": contenido}}]},
            ).execute()

        if carpeta:
            resp    = drive_service.files().list(
                q=f"name = '{carpeta}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
                pageSize=3, fields="files(id)",
            ).execute()
            folders = resp.get("files", [])
            if folders:
                drive_service.files().update(
                    fileId=doc_id,
                    addParents=folders[0]["id"],
                    removeParents="root",
                    fields="id, parents",
                ).execute()

        url = f"https://docs.google.com/document/d/{doc_id}/edit"
        # Mostrar en dashboard automáticamente
        try:
            req.post(f"{DASHBOARD_URL}/cairo/show",
                     json={"name": titulo, "url": url, "file_type": "doc"}, timeout=3)
        except Exception:
            pass
        return f"Documento '{titulo}' creado en Drive."

    except Exception as e:
        return f"Error al crear '{titulo}': {e}"


@tool
def actualizar_documento_drive(nombre: str, contenido: str, modo: str = "reemplazar") -> str:
    """
    Modifica el contenido de un Google Doc existente.
    Usar cuando el usuario quiera editar, reescribir o agregar texto a un documento.
    nombre: nombre exacto o parcial del documento
    contenido: nuevo texto
    modo: 'reemplazar' para borrar todo y escribir de nuevo, 'agregar' para añadir al final
    """
    try:
        creds         = get_google_creds()
        drive_service = build("drive", "v3", credentials=creds)
        docs_service  = build("docs",  "v1", credentials=creds)

        archivo = _buscar_archivo(drive_service, nombre)
        if not archivo:
            return f"No encontré '{nombre}' en Drive."

        file_id   = archivo["id"]
        file_name = archivo["name"]
        mime      = archivo.get("mimeType", "")

        if mime != "application/vnd.google-apps.document":
            return f"'{file_name}' no es un Google Doc. Solo puedo editar documentos de Google."

        doc       = docs_service.documents().get(documentId=file_id).execute()
        end_index = doc["body"]["content"][-1]["endIndex"] - 1

        if modo == "reemplazar":
            requests = []
            if end_index > 1:
                requests.append({"deleteContentRange": {"range": {"startIndex": 1, "endIndex": end_index}}})
            requests.append({"insertText": {"location": {"index": 1}, "text": contenido}})
        else:  # agregar
            requests = [{"insertText": {"location": {"index": max(1, end_index)}, "text": "\n" + contenido}}]

        docs_service.documents().batchUpdate(
            documentId=file_id,
            body={"requests": requests},
        ).execute()
        return f"Documento '{file_name}' actualizado."

    except Exception as e:
        return f"Error al actualizar '{nombre}': {e}"


@tool
def eliminar_archivo_drive(nombre: str) -> str:
    """
    Mueve un archivo a la papelera de Google Drive.
    Usar cuando el usuario quiera borrar o eliminar un archivo.
    nombre: nombre exacto o parcial del archivo
    """
    try:
        creds   = get_google_creds()
        service = build("drive", "v3", credentials=creds)

        archivo = _buscar_archivo(service, nombre)
        if not archivo:
            return f"No encontré '{nombre}' en Drive."

        file_name = archivo["name"]
        service.files().update(fileId=archivo["id"], body={"trashed": True}).execute()
        return f"'{file_name}' movido a la papelera."

    except Exception as e:
        return f"Error al eliminar '{nombre}': {e}"


_CACHE_PATH = Path(__file__).parent.parent / "cache" / "drive_tree.json"


def _resolve_url(name: str) -> str:
    """Devuelve la URL exacta de un archivo buscando por nombre en el caché."""
    if not _CACHE_PATH.exists():
        return ""
    try:
        data  = json.loads(_CACHE_PATH.read_text(encoding="utf-8"))
        files = data.get("mydrive", []) + data.get("shared", []) if "mydrive" in data else data.get("files", [])
        name_lo = name.lower().strip()
        for f in files:
            if f.get("name", "").lower() == name_lo:
                return f.get("url", "")
        for f in files:
            if name_lo in f.get("name", "").lower():
                return f.get("url", "")
    except Exception:
        pass
    return ""


@tool
def resaltar_archivos_en_mapa(label: str, archivos: list) -> str:
    """
    Resalta nodos en el mapa visual del dashboard.
    Llamar SIEMPRE después de buscar_semantico, pasando los nombres de los resultados.
    label: etiqueta visible en el mapa (ej: 'validacion documental', 'propuestas comerciales')
    archivos: lista de nombres obtenidos de buscar_semantico. Pueden ser strings o dicts con 'name' y 'url'.
              Ejemplo: ["Propuesta Comercial MODO", "Caso de Exito Banco"]
              No incluir prefijos como [DRIVE/mydrive], [JIRA] ni anotaciones [doc] [xls].
    """
    if not archivos:
        return "No se proporcionaron archivos para resaltar."

    nodes = []
    for f in archivos:
        # Acepta tanto strings como dicts con clave 'name'
        if isinstance(f, str):
            name = f.strip()
            url  = ""
        else:
            name = f.get("name", "").strip()
            url  = f.get("url", "")
        if not name:
            continue
        # Limpiar posibles anotaciones del árbol: "Archivo [doc]" → "Archivo"
        clean = name.split(" [")[0].strip()
        url   = url or _resolve_url(clean)
        nodes.append({"name": clean, "url": url})

    try:
        req.post(
            f"{DASHBOARD_URL}/cairo/highlight",
            json={"label": label, "nodes": nodes},
            timeout=3,
        )
        print(f"[Highlight] {len(nodes)} nodos → '{label}'")
    except Exception as e:
        print(f"[Highlight] Error POST: {e}")

    lines = [f"Resaltando {len(nodes)} archivo(s) — '{label}':"]
    for i, n in enumerate(nodes[:10], 1):
        lines.append(f"{i}. {n['name']}")
    if len(nodes) > 10:
        lines.append(f"  ... y {len(nodes) - 10} más")
    return "\n".join(lines)


@tool
def crear_carpeta_drive(nombre: str, carpeta_padre: str = "", padre_id: str = "") -> str:
    """
    Crea una nueva carpeta en Google Drive.
    Usar cuando el usuario quiera crear una carpeta, directorio o categoría en Drive.
    nombre: nombre de la carpeta a crear
    carpeta_padre: nombre de la carpeta donde crearla (opcional)
    padre_id: ID de Drive de la carpeta padre — preferir sobre carpeta_padre cuando está disponible en el árbol.
              Extraerlo de la URL: en 'https://drive.google.com/drive/folders/ID', el ID es la última parte.
    """
    try:
        creds   = get_google_creds()
        service = build("drive", "v3", credentials=creds)

        metadata: dict = {
            "name":     nombre,
            "mimeType": "application/vnd.google-apps.folder",
        }

        if padre_id:
            metadata["parents"] = [padre_id]
        elif carpeta_padre:
            padre = _buscar_archivo(service, carpeta_padre, tipo="folder")
            if not padre:
                return f"No encontré la carpeta '{carpeta_padre}' en Drive."
            metadata["parents"] = [padre["id"]]

        carpeta = service.files().create(body=metadata, fields="id, name, webViewLink").execute()
        ubicacion = f"dentro de '{carpeta_padre or padre_id}'" if (carpeta_padre or padre_id) else "en My Drive"
        return f"Carpeta '{carpeta['name']}' creada {ubicacion}."
    except Exception as e:
        return f"Error al crear la carpeta '{nombre}': {e}"


@tool
def renombrar_elemento_drive(nombre_actual: str, nuevo_nombre: str, archivo_id: str = "") -> str:
    """
    Renombra una carpeta o archivo en Google Drive.
    Usar cuando el usuario quiera cambiar el nombre de una carpeta o archivo.
    nombre_actual: nombre exacto o parcial del elemento a renombrar
    nuevo_nombre: nuevo nombre que tendrá el elemento
    archivo_id: ID de Drive del elemento — preferir sobre nombre_actual cuando está disponible en el árbol.
    """
    try:
        creds   = get_google_creds()
        service = build("drive", "v3", credentials=creds)

        archivo = _buscar_archivo(service, nombre_actual, file_id=archivo_id)
        if not archivo:
            return f"No encontré '{nombre_actual}' en Drive."

        service.files().update(
            fileId=archivo["id"],
            body={"name": nuevo_nombre},
            fields="id, name",
        ).execute()
        return f"'{archivo['name']}' renombrado a '{nuevo_nombre}'."
    except Exception as e:
        return f"Error al renombrar '{nombre_actual}': {e}"


@tool
def mover_a_carpeta_drive(nombre: str, carpeta_destino: str, archivo_id: str = "", destino_id: str = "") -> str:
    """
    Mueve un archivo o carpeta a otra carpeta en Google Drive.
    Usar cuando el usuario quiera mover, reubicar u organizar un archivo o carpeta.
    nombre: nombre exacto o parcial del archivo/carpeta a mover
    carpeta_destino: nombre de la carpeta destino
    archivo_id: ID de Drive del elemento a mover — preferir cuando está disponible en el árbol.
    destino_id: ID de Drive de la carpeta destino — preferir cuando está disponible en el árbol.
                Extraerlo de la URL: en 'https://drive.google.com/drive/folders/ID', el ID es la última parte.
    """
    try:
        creds   = get_google_creds()
        service = build("drive", "v3", credentials=creds)

        archivo = _buscar_archivo(service, nombre, file_id=archivo_id)
        if not archivo:
            return f"No encontré '{nombre}' en Drive."

        if destino_id:
            destino_file_id = destino_id
            destino_nombre  = carpeta_destino or destino_id
        else:
            destino = _buscar_archivo(service, carpeta_destino, tipo="folder")
            if not destino:
                return f"No encontré la carpeta destino '{carpeta_destino}' en Drive."
            destino_file_id = destino["id"]
            destino_nombre  = destino["name"]

        # Obtener padres actuales para removerlos
        actual = service.files().get(fileId=archivo["id"], fields="parents").execute()
        padres_actuales = ",".join(actual.get("parents", []))

        service.files().update(
            fileId=archivo["id"],
            addParents=destino_file_id,
            removeParents=padres_actuales,
            fields="id, parents",
        ).execute()
        return f"'{archivo['name']}' movido a '{destino_nombre}'."
    except Exception as e:
        return f"Error al mover '{nombre}': {e}"


@tool
def listar_archivos_recientes(cantidad: int = 5) -> str:
    """
    Lista los archivos más recientemente modificados en Google Drive y los muestra en el dashboard.
    Usar cuando el usuario pida 'mis últimos archivos' o 'en qué estuve trabajando'.
    cantidad: número de archivos a mostrar (default 5)
    """
    try:
        creds   = get_google_creds()
        service = build("drive", "v3", credentials=creds)
        results = service.files().list(
            pageSize=cantidad,
            orderBy="modifiedTime desc",
            fields="files(id, name, mimeType, webViewLink, modifiedTime)",
            q="trashed=false",
        ).execute()
        files = results.get("files", [])
        if not files:
            return "No encontré archivos recientes."

        for f in files:
            try:
                req.post(f"{DASHBOARD_URL}/cairo/show", json={
                    "name":      f["name"],
                    "url":       f.get("webViewLink", ""),
                    "file_type": _mime_to_type(f.get("mimeType", "")),
                }, timeout=3)
            except Exception:
                pass

        lines = [f"Tus {len(files)} archivos más recientes (en el dashboard):"]
        for i, f in enumerate(files, 1):
            mod = f.get("modifiedTime", "")[:10]
            lines.append(f"{i}. [{mod}] {f['name']}")
        return "\n".join(lines)
    except Exception as e:
        return f"Error al listar archivos: {str(e)}"
