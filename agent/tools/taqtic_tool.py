"""
tools/taqtic_tool.py — Herramienta Taqtic para el agente
Ajustá los endpoints según la API de tu instancia de Taqtic.
"""
import requests
from langchain.tools import tool

from config import load_config


def taqtic_headers():
    cfg = load_config()["taqtic"]
    return {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }


def taqtic_url(path: str) -> str:
    cfg = load_config()["taqtic"]
    return f"{cfg['api_url']}{path}"


@tool
def listar_tareas_taqtic(estado: str = "pending") -> str:
    """
    Lista tareas en Taqtic asignadas al usuario.
    Usar cuando pregunten sobre tareas pendientes, proyectos en Taqtic.
    estado: 'pending', 'in_progress', 'completed'
    """
    try:
        resp = requests.get(
            taqtic_url("/tasks"),
            headers=taqtic_headers(),
            params={"status": estado, "assigned_to": "me", "limit": 8},
        )
        resp.raise_for_status()
        tasks = resp.json().get("data", [])
        if not tasks:
            return f"No tenés tareas con estado '{estado}' en Taqtic."
        lines = [f"Tus tareas en Taqtic ({estado}):"]
        for t in tasks:
            lines.append(f"- [{t.get('id')}] {t.get('title', 'Sin título')} — Proyecto: {t.get('project', {}).get('name', '?')}")
        return "\n".join(lines)
    except Exception as e:
        return f"Error al conectar con Taqtic: {str(e)}"


@tool
def crear_tarea_taqtic(titulo: str, proyecto: str, descripcion: str = "", prioridad: str = "normal") -> str:
    """
    Crea una nueva tarea en Taqtic.
    Usar cuando el usuario quiera agregar una tarea a un proyecto de Taqtic.
    titulo: nombre de la tarea
    proyecto: nombre o ID del proyecto
    descripcion: descripción opcional
    prioridad: 'low', 'normal', 'high', 'urgent'
    """
    try:
        payload = {
            "title": titulo,
            "project": proyecto,
            "description": descripcion,
            "priority": prioridad,
        }
        resp = requests.post(
            taqtic_url("/tasks"),
            headers=taqtic_headers(),
            json=payload,
        )
        resp.raise_for_status()
        task = resp.json().get("data", {})
        return f"Tarea '{titulo}' creada en Taqtic (ID: {task.get('id')}). Proyecto: {proyecto}."
    except Exception as e:
        return f"Error al crear tarea en Taqtic: {str(e)}"


@tool
def ver_proyectos_taqtic() -> str:
    """
    Lista los proyectos activos en Taqtic.
    Usar cuando el usuario pregunte qué proyectos tiene o quiera saber sobre su cartera.
    """
    try:
        resp = requests.get(
            taqtic_url("/projects"),
            headers=taqtic_headers(),
            params={"status": "active", "limit": 10},
        )
        resp.raise_for_status()
        projects = resp.json().get("data", [])
        if not projects:
            return "No encontré proyectos activos en Taqtic."
        lines = ["Proyectos activos en Taqtic:"]
        for p in projects:
            lines.append(f"- {p.get('name')} (ID: {p.get('id')}) — {p.get('task_count', 0)} tareas")
        return "\n".join(lines)
    except Exception as e:
        return f"Error al obtener proyectos de Taqtic: {str(e)}"
