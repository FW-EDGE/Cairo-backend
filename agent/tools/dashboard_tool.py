"""
tools/dashboard_tool.py — Herramientas para interactuar con el dashboard de Cairo
"""
import requests as req
from langchain.tools import tool

DASHBOARD_URL = "http://localhost:7777"


@tool
def mostrar_en_dashboard(nombre: str, url: str, tipo: str = "file") -> str:
    """
    Muestra un archivo o link en el dashboard del usuario.
    Usar cuando el usuario pida ver, abrir o que le muestres un archivo específico de Drive.
    nombre: nombre del archivo
    url: link directo al archivo en Google Drive
    tipo: tipo de archivo — 'doc', 'sheet', 'slide', 'pdf', 'image', 'folder', 'file'
    """
    try:
        req.post(
            f"{DASHBOARD_URL}/cairo/show",
            json={"name": nombre, "url": url, "file_type": tipo},
            timeout=3,
        )
        return f"Mostrando '{nombre}' en el dashboard."
    except Exception:
        return f"No pude conectar con el dashboard. El archivo es: {url}"


@tool
def expandir_panel_dashboard(panel: str) -> str:
    """
    Expande un panel específico del dashboard para que el usuario pueda verlo en detalle.
    Usar cuando el usuario quiera explorar archivos de Drive, ver el mapa de nodos, revisar tickets de Jira,
    o consultar su calendario. También usar si el usuario dice "muéstrame", "quiero ver", "ábrelo", etc.
    panel: 'map' → mapa de archivos/Drive (Neural Map)
           'jira' → tablero de incidencias de Jira
           'calendar' → calendario semanal
    """
    panel_names = {
        "map":      "mapa de archivos (Neural Map)",
        "jira":     "tablero de Jira",
        "calendar": "calendario",
    }
    try:
        req.post(f"{DASHBOARD_URL}/ui/expand", json={"panel": panel}, timeout=3)
        return f"Panel '{panel_names.get(panel, panel)}' expandido en el dashboard."
    except Exception:
        return f"No pude conectar con el dashboard para expandir el panel."


@tool
def mostrar_varios_en_dashboard(archivos: list) -> str:
    """
    Muestra múltiples archivos en el dashboard.
    Usar cuando el usuario pida ver varios archivos a la vez.
    archivos: lista de dicts con 'nombre', 'url' y opcionalmente 'tipo'
    Ejemplo: [{"nombre": "Informe Q1", "url": "https://...", "tipo": "sheet"}]
    """
    mostrados = []
    for a in archivos:
        try:
            req.post(
                f"{DASHBOARD_URL}/cairo/show",
                json={
                    "name":      a.get("nombre", a.get("name", "Archivo")),
                    "url":       a.get("url", ""),
                    "file_type": a.get("tipo", a.get("type", "file")),
                },
                timeout=3,
            )
            mostrados.append(a.get("nombre", a.get("name", "?")))
        except Exception:
            pass
    if mostrados:
        return f"Mostrando en el dashboard: {', '.join(mostrados)}."
    return "No pude mostrar los archivos en el dashboard."
