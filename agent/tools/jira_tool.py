"""
tools/jira_tool.py — Herramienta Jira para el agente
"""
import requests
from langchain.tools import tool
from requests.auth import HTTPBasicAuth

from config import load_config


def jira_client():
    cfg = load_config()["jira"]
    return cfg["server_url"], HTTPBasicAuth(cfg["email"], cfg["api_token"])


@tool
def listar_mis_tickets_jira(estado: str = "") -> str:
    """
    Lista los tickets de Jira asignados al usuario actual.
    Usar cuando pregunten qué tickets tiene asignados, en qué está trabajando, etc.
    estado: filtro opcional de estado (dejar vacío para traer todos los activos).
    """
    try:
        server, auth = jira_client()
        if estado:
            jql = f'assignee = currentUser() AND status = "{estado}" ORDER BY priority ASC, updated DESC'
        else:
            jql = "assignee = currentUser() ORDER BY priority ASC, updated DESC"
        resp = requests.get(
            f"{server}/rest/api/3/search/jql",
            auth=auth,
            params={"jql": jql, "maxResults": 20, "fields": "summary,status,priority"},
        )
        resp.raise_for_status()
        issues = resp.json().get("issues", [])
        if not issues:
            return "No tenés tickets asignados." if not estado else f"No tenés tickets con estado '{estado}'."
        lines = [f"Tus tickets ({len(issues)}):"]
        for issue in issues:
            key      = issue["key"]
            summary  = issue["fields"]["summary"][:70]
            priority = issue["fields"].get("priority", {}).get("name", "?")
            status   = issue["fields"]["status"]["name"]
            lines.append(f"- [{key}] {summary} — {status} (Prioridad: {priority})")
        return "\n".join(lines)
    except Exception as e:
        return f"Error al conectar con Jira: {str(e)}"


@tool
def crear_ticket_jira(titulo: str, descripcion: str = "", tipo: str = "Task", prioridad: str = "Medium") -> str:
    """
    Crea un nuevo ticket en Jira.
    Usar cuando el usuario quiera reportar un bug, crear una tarea, etc.
    titulo: resumen del ticket
    descripcion: descripción detallada (opcional)
    tipo: 'Task', 'Bug', 'Story', 'Epic'
    prioridad: 'Highest', 'High', 'Medium', 'Low', 'Lowest'
    """
    try:
        cfg = load_config()["jira"]
        server, auth = jira_client()
        payload = {
            "fields": {
                "project": {"key": cfg["default_project"]},
                "summary": titulo,
                "description": {
                    "type": "doc",
                    "version": 1,
                    "content": [{"type": "paragraph", "content": [{"type": "text", "text": descripcion}]}],
                },
                "issuetype": {"name": tipo},
                "priority": {"name": prioridad},
            }
        }
        resp = requests.post(
            f"{server}/rest/api/3/issue",
            auth=auth,
            json=payload,
        )
        resp.raise_for_status()
        data = resp.json()
        key = data["key"]
        url = f"{server}/browse/{key}"
        return f"Ticket {key} creado: '{titulo}'. Link: {url}"
    except Exception as e:
        return f"Error al crear ticket en Jira: {str(e)}"


@tool
def cambiar_estado_ticket_jira(key: str, estado: str) -> str:
    """
    Cambia el estado de un ticket de Jira.
    Usar cuando el usuario quiera mover un ticket a otro estado.
    key: clave del ticket, ej: 'GTTS-186'
    estado: nombre del estado destino, ej: 'En curso', 'Finalizada', 'En revisión', 'Tareas por hacer'
    """
    try:
        server, auth = jira_client()

        # Get available transitions
        resp = requests.get(
            f"{server}/rest/api/3/issue/{key}/transitions",
            auth=auth,
            timeout=10,
        )
        resp.raise_for_status()
        transitions = resp.json().get("transitions", [])

        # Find matching transition (case-insensitive, partial match)
        estado_lower = estado.lower().strip()
        match = next(
            (t for t in transitions if estado_lower in t["name"].lower() or estado_lower in t["to"]["name"].lower()),
            None,
        )
        if not match:
            available = ", ".join(f"'{t['to']['name']}'" for t in transitions)
            return f"No encontré la transición '{estado}'. Estados disponibles: {available}"

        # Apply transition
        resp2 = requests.post(
            f"{server}/rest/api/3/issue/{key}/transitions",
            auth=auth,
            json={"transition": {"id": match["id"]}},
            timeout=10,
        )
        resp2.raise_for_status()
        return f"Ticket {key} movido a '{match['to']['name']}'."
    except Exception as e:
        return f"Error al cambiar estado de {key}: {str(e)}"


@tool
def buscar_tickets_jira(texto: str) -> str:
    """
    Busca tickets en Jira por texto.
    Usar cuando el usuario busque un issue específico, bug, o feature.
    texto: término de búsqueda
    """
    try:
        server, auth = jira_client()
        jql = f'text ~ "{texto}" ORDER BY updated DESC'
        resp = requests.get(
            f"{server}/rest/api/3/search/jql",
            auth=auth,
            params={"jql": jql, "maxResults": 5, "fields": "summary,status,assignee"},
        )
        resp.raise_for_status()
        issues = resp.json().get("issues", [])
        if not issues:
            return f"No encontré tickets con '{texto}'."
        lines = [f"Tickets relacionados con '{texto}':"]
        for i in issues:
            status = i["fields"]["status"]["name"]
            lines.append(f"- [{i['key']}] {i['fields']['summary'][:55]} ({status})")
        return "\n".join(lines)
    except Exception as e:
        return f"Error al buscar en Jira: {str(e)}"
