"""
agent.py — Agente CAIRO con soporte multi-provider
Providers soportados: grok | openai | bedrock
Cambiá llm.provider en config.yaml para switchear sin tocar código.
"""
import json
from collections import defaultdict
from pathlib import Path
from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.messages import HumanMessage, AIMessage
from langchain_core.language_models.chat_models import BaseChatModel

from config import load_config

from tools.drive_tool import (
    listar_archivos_recientes, mostrar_archivo_drive,
    leer_archivo_drive, crear_documento_drive,
    actualizar_documento_drive, eliminar_archivo_drive,
    resaltar_archivos_en_mapa,
    crear_carpeta_drive, renombrar_elemento_drive, mover_a_carpeta_drive,
)
from tools.calendar_tool import ver_eventos_hoy, crear_evento, ver_proximos_eventos, leer_emails_no_leidos
from tools.jira_tool import listar_mis_tickets_jira, crear_ticket_jira, buscar_tickets_jira, cambiar_estado_ticket_jira
from tools.taqtic_tool import listar_tareas_taqtic, crear_tarea_taqtic, ver_proyectos_taqtic
from tools.dashboard_tool import mostrar_en_dashboard, mostrar_varios_en_dashboard, expandir_panel_dashboard
from tools.embeddings_tool import buscar_semantico
from tools.obsidian_tool import (
    buscar_en_vault, leer_nota, crear_nota, agregar_a_nota,
    escribir_daily_note, crear_nota_reunion,
    listar_tareas_pendientes, buscar_notas_por_tag,
)

ALL_TOOLS = [
    listar_archivos_recientes, mostrar_archivo_drive,
    leer_archivo_drive, crear_documento_drive,
    actualizar_documento_drive, eliminar_archivo_drive,
    resaltar_archivos_en_mapa,
    crear_carpeta_drive, renombrar_elemento_drive, mover_a_carpeta_drive,
    ver_eventos_hoy, crear_evento, ver_proximos_eventos, leer_emails_no_leidos,
    listar_mis_tickets_jira, crear_ticket_jira, buscar_tickets_jira, cambiar_estado_ticket_jira,
    listar_tareas_taqtic, crear_tarea_taqtic, ver_proyectos_taqtic,
    mostrar_en_dashboard, mostrar_varios_en_dashboard, expandir_panel_dashboard,
    buscar_semantico,
    buscar_en_vault, leer_nota, crear_nota, agregar_a_nota,
    escribir_daily_note, crear_nota_reunion,
    listar_tareas_pendientes, buscar_notas_por_tag,
]

DRIVE_CACHE = Path(__file__).parent / "cache" / "drive_tree.json"


def _build_drive_tree_text() -> str:
    """
    Lee el cache del árbol de Drive y lo formatea como texto jerárquico
    para inyectarlo en el contexto del LLM (modo clásico).
    """
    if not DRIVE_CACHE.exists():
        return ""

    try:
        data      = json.loads(DRIVE_CACHE.read_text(encoding="utf-8"))
        # Soportar formato nuevo {mydrive, shared} y formato viejo {files}
        if "mydrive" in data:
            files = data.get("mydrive", []) + data.get("shared", [])
        else:
            files = data.get("files", [])
        timestamp = data.get("fetched_at", "")[:10]
        if not files:
            return ""

        by_id       = {f["id"]: f for f in files if f.get("id")}
        children_of = defaultdict(list)
        for f in files:
            for p in f.get("parents", []):
                children_of[p].append(f["id"])

        for p in children_of:
            children_of[p].sort(key=lambda fid: (
                0 if by_id.get(fid, {}).get("type") == "folder" else 1,
                by_id.get(fid, {}).get("name", "").lower(),
            ))

        lines = [f"## Árbol de Google Drive (actualizado: {timestamp})\n"]

        def render(node_id: str, depth: int = 0):
            f = by_id.get(node_id)
            if not f:
                return
            indent = "  " * depth
            icon   = "📁" if f["type"] == "folder" else "📄"
            url    = f.get("url", "")
            lines.append(f"{indent}{icon} {f['name']} [{f['type']}] → {url}")
            for child_id in children_of.get(node_id, []):
                render(child_id, depth + 1)

        for root_child in children_of.get("root", []):
            render(root_child)

        # Archivos compartidos
        shared_roots = children_of.get("__shared__", [])
        if shared_roots:
            lines.append("\n## Archivos compartidos conmigo\n")
            for child_id in shared_roots:
                render(child_id, depth=0)

        tree_text = "\n".join(lines)
        print(f"[Agent] Árbol de Drive cargado: {len(files)} archivos, {len(tree_text)} chars")
        return tree_text

    except Exception as e:
        print(f"[Agent] Error al cargar árbol de Drive: {e}")
        return ""


def build_compact_drive_tree() -> str:
    """
    Árbol de navegación de Drive: solo nombres y estructura de carpetas.
    Sin URLs ni IDs — el acceso real se hace con las tools por nombre.
    Formato jerárquico indentado, ~5x más compacto que el árbol completo.
    """
    if not DRIVE_CACHE.exists():
        return ""

    try:
        data      = json.loads(DRIVE_CACHE.read_text(encoding="utf-8"))
        if "mydrive" in data:
            files = data.get("mydrive", []) + data.get("shared", [])
        else:
            files = data.get("files", [])
        timestamp = data.get("fetched_at", "")[:10]
        if not files:
            return ""

        by_id       = {f["id"]: f for f in files if f.get("id")}
        children_of = defaultdict(list)
        for f in files:
            for p in f.get("parents", []):
                children_of[p].append(f["id"])

        # Carpetas primero, luego alfabético
        for p in children_of:
            children_of[p].sort(key=lambda fid: (
                0 if by_id.get(fid, {}).get("type") == "folder" else 1,
                by_id.get(fid, {}).get("name", "").lower(),
            ))

        n_folders = sum(1 for f in files if f.get("type") == "folder")
        n_files   = len(files) - n_folders
        lines     = [
            f"Google Drive ({n_folders} carpetas, {n_files} archivos — {timestamp})",
            "",
        ]

        TYPE_ABBR = {"doc": "doc", "sheet": "xls", "slide": "ppt",
                     "pdf": "pdf", "image": "img", "file": ""}

        def render(node_id: str, depth: int = 0):
            f = by_id.get(node_id)
            if not f:
                return
            pad = "  " * depth
            if f["type"] == "folder":
                lines.append(f"{pad}{f['name']}/")
            else:
                abbr   = TYPE_ABBR.get(f.get("type", ""), "")
                suffix = f" [{abbr}]" if abbr else ""
                lines.append(f"{pad}{f['name']}{suffix}")
            for child_id in children_of.get(node_id, []):
                render(child_id, depth + 1)

        lines.append("Mi Drive:")
        for root_child in children_of.get("root", []):
            render(root_child)

        # Archivos compartidos conmigo
        shared_roots = children_of.get("__shared__", [])
        if shared_roots:
            lines.append("")
            lines.append("Compartidos conmigo:")
            for child_id in shared_roots:
                render(child_id)

        tree = "\n".join(lines)
        print(f"[Agent] Árbol de navegación: {len(files)} items, {len(tree)} chars")
        return tree

    except Exception as e:
        print(f"[Agent] Error al construir árbol: {e}")
        return ""


def build_llm(llm_cfg: dict) -> BaseChatModel:
    provider = llm_cfg.get("provider", "grok").lower()
    cfg      = llm_cfg.get(provider, {})

    if provider == "openai":
        try:
            from langchain_openai import ChatOpenAI
        except ImportError:
            raise ImportError("Instalá langchain-openai: pip install langchain-openai")
        print(f"[LLM] OpenAI -> {cfg['model']}")
        return ChatOpenAI(
            model=cfg["model"],
            temperature=cfg.get("temperature", 0.5),
            api_key=cfg["api_key"],
        )

    elif provider == "bedrock":
        try:
            from langchain_aws import ChatBedrock
        except ImportError:
            raise ImportError("Instalá langchain-aws: pip install langchain-aws")
        print(f"[LLM] Bedrock -> {cfg['model']} ({cfg.get('region', 'us-east-1')})")
        return ChatBedrock(
            model_id=cfg["model"],
            region_name=cfg.get("region", "us-east-1"),
            aws_access_key_id=cfg["aws_access_key_id"],
            aws_secret_access_key=cfg["aws_secret_access_key"],
            model_kwargs={"temperature": cfg.get("temperature", 0.5)},
        )

    else:  # grok (default)
        try:
            from langchain_openai import ChatOpenAI
        except ImportError:
            raise ImportError("Instalá langchain-openai: pip install langchain-openai")
        print(f"[LLM] Grok -> {cfg['model']} ({cfg.get('base_url', 'https://api.x.ai/v1')})")
        return ChatOpenAI(
            model=cfg["model"],
            temperature=cfg.get("temperature", 0.5),
            api_key=cfg["api_key"],
            base_url=cfg.get("base_url", "https://api.x.ai/v1"),
        )


class JarvisAgent:
    def __init__(self):
        cfg       = load_config()
        llm_cfg   = cfg["llm"]
        agent_cfg = cfg["agent"]

        self.llm = build_llm(llm_cfg)

        # Inyectar el árbol completo de Drive en el system prompt
        drive_tree  = _build_drive_tree_text()
        system_text = agent_cfg["system_prompt"]
        if drive_tree:
            system_text = (
                system_text.rstrip()
                + "\n\n"
                + drive_tree
                + "\n\nCuando el usuario mencione un archivo o carpeta, buscalo en el árbol de arriba. "
                  "Usá mostrar_archivo_drive para enviar el archivo al dashboard."
            )

        prompt = ChatPromptTemplate.from_messages([
            ("system", system_text),
            MessagesPlaceholder(variable_name="chat_history"),
            ("human", "{input}"),
            MessagesPlaceholder(variable_name="agent_scratchpad"),
        ])

        agent = create_tool_calling_agent(self.llm, ALL_TOOLS, prompt)
        self.executor = AgentExecutor(
            agent=agent,
            tools=ALL_TOOLS,
            verbose=False,
            max_iterations=agent_cfg["max_iterations"],
            handle_parsing_errors=True,
        )
        self.history: list = []
        print("[Agent] Listo.")

    def chat(self, user_input: str) -> str:
        try:
            result = self.executor.invoke({
                "input": user_input,
                "chat_history": self.history,
            })
            response = result.get("output", "No pude procesar eso.")
            self.history.append(HumanMessage(content=user_input))
            self.history.append(AIMessage(content=response))
            if len(self.history) > 20:
                self.history = self.history[-20:]
            return response
        except Exception as e:
            return f"Hubo un error: {str(e)}"

    def reset_history(self) -> str:
        self.history = []
        return "Historial limpiado."
