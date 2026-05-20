"""
tools/calendar_tool.py — Herramientas Google Calendar y Gmail para el agente
"""
from datetime import datetime, timedelta
from googleapiclient.discovery import build
from langchain.tools import tool
from tools.drive_tool import get_google_creds


# ─── CALENDAR ────────────────────────────────────────────────

def _get_all_calendars(service) -> list[dict]:
    """Retorna todos los calendarios del usuario con paginación completa."""
    calendars = []
    page_token = None
    while True:
        params = {"showHidden": True, "showDeleted": False}
        if page_token:
            params["pageToken"] = page_token
        result = service.calendarList().list(**params).execute()
        calendars.extend(result.get("items", []))
        page_token = result.get("nextPageToken")
        if not page_token:
            break
    return calendars


def _fetch_events(service, time_min: str, time_max: str, max_results: int = 50) -> list:
    """Trae eventos de todos los calendarios del usuario en el rango dado."""
    calendars = _get_all_calendars(service)
    all_events = []
    for cal in calendars:
        cal_id = cal["id"]
        try:
            resp = service.events().list(
                calendarId=cal_id,
                timeMin=time_min,
                timeMax=time_max,
                maxResults=max_results,
                singleEvents=True,
                orderBy="startTime",
                showHiddenInvitations=True,
            ).execute()
            all_events.extend(resp.get("items", []))
        except Exception as e:
            print(f"[Calendar] Error en calendario '{cal.get('summary', cal_id)}': {e}")
    all_events.sort(key=lambda e: e["start"].get("dateTime", e["start"].get("date", "")))
    return all_events


@tool
def ver_eventos_hoy() -> str:
    """
    Muestra los eventos del calendario para hoy.
    Usar cuando pregunten qué reuniones hay hoy, qué tengo pendiente hoy, etc.
    """
    try:
        creds = get_google_creds()
        service = build("calendar", "v3", credentials=creds)
        now = datetime.utcnow()
        start = now.replace(hour=0, minute=0, second=0).isoformat() + "Z"
        end = now.replace(hour=23, minute=59, second=59).isoformat() + "Z"
        events = _fetch_events(service, start, end)
        if not events:
            return "No tenés eventos agendados para hoy."
        lines = [f"Eventos de hoy ({now.strftime('%d/%m/%Y')}):"]
        for e in events:
            start_dt = e["start"].get("dateTime", e["start"].get("date", ""))
            hora = start_dt[11:16] if "T" in start_dt else "todo el día"
            lines.append(f"- {hora}: {e.get('summary', 'Sin título')}")
        return "\n".join(lines)
    except Exception as e:
        return f"Error al leer el calendario: {str(e)}"


@tool
def crear_evento(titulo: str, fecha_hora: str, duracion_minutos: int = 60, descripcion: str = "") -> str:
    """
    Crea un evento en Google Calendar.
    Usar cuando el usuario quiera agendar una reunión, recordatorio, etc.
    titulo: nombre del evento
    fecha_hora: en formato 'YYYY-MM-DD HH:MM' (ej: '2025-04-20 14:30')
    duracion_minutos: duración en minutos (default 60)
    descripcion: descripción opcional
    """
    try:
        creds = get_google_creds()
        service = build("calendar", "v3", credentials=creds)
        dt_start = datetime.strptime(fecha_hora, "%Y-%m-%d %H:%M")
        dt_end = dt_start + timedelta(minutes=duracion_minutos)
        event = {
            "summary": titulo,
            "description": descripcion,
            "start": {"dateTime": dt_start.isoformat(), "timeZone": "America/Argentina/Buenos_Aires"},
            "end": {"dateTime": dt_end.isoformat(), "timeZone": "America/Argentina/Buenos_Aires"},
        }
        created = service.events().insert(calendarId="primary", body=event).execute()
        return f"Evento '{titulo}' creado para el {dt_start.strftime('%d/%m a las %H:%M')}. Link: {created.get('htmlLink')}"
    except Exception as e:
        return f"Error al crear el evento: {str(e)}"


@tool
def ver_proximos_eventos(dias: int = 7) -> str:
    """
    Muestra los próximos eventos del calendario.
    Usar cuando pregunten qué hay esta semana, próximas reuniones, etc.
    dias: cuántos días hacia adelante mostrar (default 7)
    """
    try:
        creds = get_google_creds()
        service = build("calendar", "v3", credentials=creds)
        now = datetime.utcnow().isoformat() + "Z"
        end = (datetime.utcnow() + timedelta(days=dias)).isoformat() + "Z"
        events = _fetch_events(service, now, end, max_results=50)
        if not events:
            return f"No tenés eventos en los próximos {dias} días."
        lines = [f"Próximos eventos ({dias} días):"]
        for e in events:
            start_dt = e["start"].get("dateTime", e["start"].get("date", ""))
            if "T" in start_dt:
                lines.append(f"- {start_dt[:10]} {start_dt[11:16]}: {e.get('summary', 'Sin título')}")
            else:
                lines.append(f"- {start_dt}: {e.get('summary', 'Sin título')} (todo el día)")
        return "\n".join(lines)
    except Exception as e:
        return f"Error al leer el calendario: {str(e)}"


# ─── GMAIL ───────────────────────────────────────────────────

@tool
def leer_emails_no_leidos(cantidad: int = 5) -> str:
    """
    Lee los emails no leídos más recientes de Gmail.
    Usar cuando pregunten si hay correos nuevos, qué emails tienen, etc.
    cantidad: número de emails a mostrar (default 5)
    """
    try:
        creds = get_google_creds()
        service = build("gmail", "v1", credentials=creds)
        results = service.users().messages().list(
            userId="me",
            q="is:unread",
            maxResults=cantidad,
        ).execute()
        messages = results.get("messages", [])
        if not messages:
            return "No tenés emails no leídos."
        lines = [f"Tenés {results.get('resultSizeEstimate', 0)} email(s) no leído(s). Los más recientes:"]
        for msg in messages[:cantidad]:
            detail = service.users().messages().get(
                userId="me", id=msg["id"], format="metadata",
                metadataHeaders=["From", "Subject", "Date"],
            ).execute()
            headers = {h["name"]: h["value"] for h in detail.get("payload", {}).get("headers", [])}
            sender = headers.get("From", "Desconocido")[:40]
            subject = headers.get("Subject", "Sin asunto")[:60]
            lines.append(f"- De: {sender}\n  Asunto: {subject}")
        return "\n".join(lines)
    except Exception as e:
        return f"Error al leer emails: {str(e)}"
