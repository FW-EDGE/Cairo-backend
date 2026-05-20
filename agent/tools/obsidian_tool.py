"""
tools/obsidian_tool.py — Herramienta Obsidian para el agente Jarvis
Lee y escribe directamente en tu vault de Obsidian (archivos .md locales).
"""
import re
import yaml
from pathlib import Path
from datetime import datetime
from langchain.tools import tool

from config import load_config


def vault_path() -> Path:
    cfg = load_config().get("obsidian", {})
    path = Path(cfg.get("vault_path", ""))
    if not path.exists():
        raise FileNotFoundError(
            f"Vault de Obsidian no encontrado en '{path}'. "
            "Revisá obsidian.vault_path en config.yaml."
        )
    return path


def _leer_md(file: Path) -> str:
    """Lee un archivo .md y devuelve su contenido."""
    try:
        return file.read_text(encoding="utf-8")
    except Exception:
        return ""


def _escribir_md(file: Path, contenido: str) -> None:
    """Escribe contenido en un archivo .md, creando carpetas si hacen falta."""
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(contenido, encoding="utf-8")


def _extraer_frontmatter(contenido: str) -> dict:
    """Extrae el frontmatter YAML de una nota."""
    match = re.match(r"^---\n(.*?)\n---\n", contenido, re.DOTALL)
    if match:
        try:
            return yaml.safe_load(match.group(1)) or {}
        except Exception:
            return {}
    return {}


# ─── HERRAMIENTAS ────────────────────────────────────────────

@tool
def buscar_en_vault(query: str) -> str:
    """
    Busca texto en todas las notas del vault de Obsidian.
    Usar cuando el usuario pregunte sobre algo que pudo haber anotado,
    quiera recordar una decisión, buscar información de un proyecto, etc.
    query: término o frase a buscar
    """
    try:
        vault = vault_path()
        resultados = []
        query_lower = query.lower()

        for md_file in vault.rglob("*.md"):
            contenido = _leer_md(md_file)
            contenido_lower = contenido.lower()
            if query_lower in contenido_lower:
                # Contar ocurrencias para ordenar por relevancia
                ocurrencias = contenido_lower.count(query_lower)
                # Obtener fragmento del primer match con más contexto
                idx = contenido_lower.find(query_lower)
                start = max(0, idx - 150)
                end = min(len(contenido), idx + len(query) + 300)
                fragmento = contenido[start:end].strip().replace("\n", " ")
                nombre = md_file.stem
                ruta_relativa = md_file.relative_to(vault)
                resultados.append((ocurrencias, nombre, str(ruta_relativa), fragmento))

        if not resultados:
            return f"No encontré ninguna nota con '{query}' en tu vault."

        # Ordenar por relevancia (más ocurrencias primero)
        resultados.sort(key=lambda x: x[0], reverse=True)
        lines = [f"Encontré '{query}' en {len(resultados)} nota(s):"]
        for _, nombre, ruta, fragmento in resultados[:5]:
            lines.append(f"\n--- {nombre} ({ruta}) ---\n...{fragmento}...")
        if len(resultados) > 5:
            lines.append(f"\n(y {len(resultados) - 5} nota(s) más)")
        return "\n".join(lines)

    except Exception as e:
        return f"Error al buscar en el vault: {str(e)}"


@tool
def leer_nota(nombre_o_ruta: str) -> str:
    """
    Lee el contenido de una nota específica del vault.
    Usar cuando el usuario pida leer, ver o recordar una nota particular.
    nombre_o_ruta: nombre de la nota (sin .md) o ruta relativa dentro del vault
    """
    try:
        vault = vault_path()

        # Buscar por nombre exacto primero
        candidatas = list(vault.rglob(f"{nombre_o_ruta}.md"))
        if not candidatas:
            # Buscar por nombre parcial
            candidatas = [f for f in vault.rglob("*.md")
                          if nombre_o_ruta.lower() in f.stem.lower()]

        if not candidatas:
            return f"No encontré ninguna nota llamada '{nombre_o_ruta}'."
        if len(candidatas) > 1:
            nombres = ", ".join(str(f.relative_to(vault)) for f in candidatas[:5])
            return f"Encontré varias notas que coinciden: {nombres}. ¿Cuál querés leer?"

        contenido = _leer_md(candidatas[0])
        # Limitar longitud para no saturar el contexto del LLM
        if len(contenido) > 3000:
            contenido = contenido[:3000] + "\n\n[...nota truncada, hay más contenido...]"
        return f"Nota '{candidatas[0].stem}':\n\n{contenido}"

    except Exception as e:
        return f"Error al leer la nota: {str(e)}"


@tool
def crear_nota(titulo: str, contenido: str, carpeta: str = "") -> str:
    """
    Crea una nota nueva en el vault de Obsidian.
    Usar cuando el usuario quiera guardar información, tomar nota de algo,
    crear un resumen, documentar una decisión, etc.
    titulo: nombre de la nota (sin .md)
    contenido: cuerpo de la nota en markdown
    carpeta: subcarpeta dentro del vault (ej: 'Reuniones', 'Proyectos/Alpha')
    """
    try:
        cfg = load_config().get("obsidian", {})
        vault = vault_path()
        fecha = datetime.now().strftime("%Y-%m-%d")
        hora = datetime.now().strftime("%H:%M")

        # Sanitizar nombre de archivo
        nombre_archivo = re.sub(r'[<>:"/\\|?*]', "-", titulo)
        nombre_archivo = nombre_archivo.strip()

        # Determinar ruta
        if carpeta:
            ruta = vault / carpeta / f"{nombre_archivo}.md"
        else:
            carpeta_default = cfg.get("default_folder", "")
            ruta = vault / carpeta_default / f"{nombre_archivo}.md" if carpeta_default else vault / f"{nombre_archivo}.md"

        # Frontmatter automático
        frontmatter = f"""---
title: {titulo}
date: {fecha}
time: {hora}
created_by: jarvis
tags: []
---

"""
        contenido_final = frontmatter + contenido
        _escribir_md(ruta, contenido_final)
        return f"Nota '{titulo}' creada en {ruta.relative_to(vault)}."

    except Exception as e:
        return f"Error al crear la nota: {str(e)}"


@tool
def agregar_a_nota(nombre_o_ruta: str, texto: str) -> str:
    """
    Agrega texto al final de una nota existente en Obsidian.
    Usar cuando el usuario quiera añadir algo a una nota que ya existe.
    nombre_o_ruta: nombre de la nota (sin .md)
    texto: texto a agregar al final
    """
    try:
        vault = vault_path()
        candidatas = list(vault.rglob(f"{nombre_o_ruta}.md"))
        if not candidatas:
            candidatas = [f for f in vault.rglob("*.md")
                          if nombre_o_ruta.lower() in f.stem.lower()]
        if not candidatas:
            return f"No encontré la nota '{nombre_o_ruta}'."

        archivo = candidatas[0]
        contenido_actual = _leer_md(archivo)
        timestamp = datetime.now().strftime("%H:%M")
        nuevo_contenido = contenido_actual.rstrip() + f"\n\n> [{timestamp}] {texto}\n"
        _escribir_md(archivo, nuevo_contenido)
        return f"Agregado a '{archivo.stem}'."

    except Exception as e:
        return f"Error al agregar a la nota: {str(e)}"


@tool
def escribir_daily_note(texto: str) -> str:
    """
    Agrega texto a la nota diaria de hoy (daily note) en Obsidian.
    Usar para registrar: tareas del día, ideas rápidas, capturas de voz,
    resúmenes de reuniones breves, recordatorios.
    texto: lo que se quiere agregar al diario de hoy
    """
    try:
        cfg = load_config().get("obsidian", {})
        vault = vault_path()
        hoy = datetime.now().strftime("%Y-%m-%d")
        hora = datetime.now().strftime("%H:%M")

        # Carpeta de daily notes configurable
        carpeta_daily = cfg.get("daily_notes_folder", "Daily Notes")
        formato = cfg.get("daily_notes_format", "%Y-%m-%d")
        nombre = datetime.now().strftime(formato)
        ruta = vault / carpeta_daily / f"{nombre}.md"

        if ruta.exists():
            # Agregar al final de la daily note existente
            contenido_actual = _leer_md(ruta)
            nuevo = contenido_actual.rstrip() + f"\n\n- [{hora}] {texto}\n"
            _escribir_md(ruta, nuevo)
            return f"Agregado a tu daily note de hoy ({hoy})."
        else:
            # Crear la daily note del día
            contenido = f"""---
date: {hoy}
tags: [daily]
---

# {hoy}

## Notas del día

- [{hora}] {texto}
"""
            _escribir_md(ruta, contenido)
            return f"Daily note de hoy ({hoy}) creada con tu nota."

    except Exception as e:
        return f"Error al escribir en la daily note: {str(e)}"


@tool
def crear_nota_reunion(titulo: str, participantes: str, resumen: str, action_items: str = "") -> str:
    """
    Crea una nota de reunión estructurada en Obsidian.
    Usar cuando el usuario dicte o describa una reunión que quiere documentar.
    titulo: nombre de la reunión
    participantes: lista de participantes separados por coma
    resumen: resumen o puntos discutidos
    action_items: tareas que quedaron pendientes, separadas por coma
    """
    try:
        cfg = load_config().get("obsidian", {})
        vault = vault_path()
        fecha = datetime.now().strftime("%Y-%m-%d")
        hora = datetime.now().strftime("%H:%M")

        nombre_archivo = f"{fecha} - {re.sub(r'[<>:\"/\\|?*]', '-', titulo)}"
        carpeta = cfg.get("meetings_folder", "Reuniones")
        ruta = vault / carpeta / f"{nombre_archivo}.md"

        # Formatear action items como lista de tareas de Obsidian
        tasks_md = ""
        if action_items:
            items = [i.strip() for i in action_items.split(",") if i.strip()]
            tasks_md = "\n## Action items\n\n" + "\n".join(f"- [ ] {item}" for item in items)

        # Formatear participantes
        partic_list = [p.strip() for p in participantes.split(",")]
        partic_md = "\n".join(f"- {p}" for p in partic_list)

        contenido = f"""---
title: {titulo}
date: {fecha}
time: {hora}
type: reunion
participants: [{', '.join(partic_list)}]
tags: [reunion]
---

# {titulo}

**Fecha:** {fecha} {hora}
**Participantes:**
{partic_md}

## Resumen

{resumen}
{tasks_md}
"""
        _escribir_md(ruta, contenido)
        n_tasks = len(action_items.split(",")) if action_items else 0
        msg = f"Nota de reunión '{titulo}' creada en {carpeta}/."
        if n_tasks:
            msg += f" Se registraron {n_tasks} action item(s)."
        return msg

    except Exception as e:
        return f"Error al crear la nota de reunión: {str(e)}"


@tool
def listar_tareas_pendientes(carpeta: str = "") -> str:
    """
    Lista todas las tareas pendientes (checkboxes sin marcar) en el vault.
    Usar cuando el usuario pregunte qué tiene pendiente, sus TODOs, etc.
    carpeta: limitar la búsqueda a una carpeta (opcional)
    """
    try:
        vault = vault_path()
        base = vault / carpeta if carpeta else vault
        tareas = []

        for md_file in base.rglob("*.md"):
            contenido = _leer_md(md_file)
            for linea in contenido.splitlines():
                if linea.strip().startswith("- [ ]"):
                    tarea = linea.strip()[5:].strip()
                    tareas.append((md_file.stem, tarea))

        if not tareas:
            ambito = f"la carpeta '{carpeta}'" if carpeta else "tu vault"
            return f"No encontré tareas pendientes en {ambito}."

        lines = [f"Tenés {len(tareas)} tarea(s) pendiente(s):"]
        for nota, tarea in tareas[:15]:
            lines.append(f"- [{nota}] {tarea}")
        if len(tareas) > 15:
            lines.append(f"(y {len(tareas) - 15} más...)")
        return "\n".join(lines)

    except Exception as e:
        return f"Error al listar tareas: {str(e)}"


@tool
def buscar_notas_por_tag(tag: str) -> str:
    """
    Busca todas las notas que tengan un tag específico en su frontmatter.
    Usar cuando el usuario quiera ver todas las notas de un proyecto,
    tipo o categoría concreta.
    tag: etiqueta a buscar (sin el #)
    """
    try:
        vault = vault_path()
        resultados = []

        for md_file in vault.rglob("*.md"):
            contenido = _leer_md(md_file)
            fm = _extraer_frontmatter(contenido)
            tags = fm.get("tags", [])
            if isinstance(tags, str):
                tags = [tags]
            if tag.lower() in [t.lower() for t in tags]:
                fecha = fm.get("date", "")
                resultados.append((md_file.stem, str(md_file.relative_to(vault)), fecha))

        if not resultados:
            return f"No encontré notas con el tag '{tag}'."

        resultados.sort(key=lambda x: x[2], reverse=True)
        lines = [f"Notas con tag '{tag}' ({len(resultados)}):"]
        for nombre, ruta, fecha in resultados[:10]:
            prefix = f"[{fecha}] " if fecha else ""
            lines.append(f"- {prefix}{nombre} ({ruta})")
        return "\n".join(lines)

    except Exception as e:
        return f"Error al buscar por tag: {str(e)}"
