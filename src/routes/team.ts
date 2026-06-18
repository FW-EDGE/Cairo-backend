import { Router, Request, Response } from 'express';
import OpenAI from 'openai';
import { requireUser } from '../auth/middleware.js';
import { getConfig } from '../config.js';
import {
  getTeamMembers,
  getTeamMemberById,
  createTeamMember,
  updateTeamMember,
  deleteTeamMember,
} from '../db/teamMembers.js';

const router = Router();

router.get('/team', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const members = await getTeamMembers(user._id);
    res.json({ members });
  } catch (err) {
    console.error('[Team] GET /team error:', err);
    res.status(500).json({ error: 'Error al obtener el equipo' });
  }
});

router.post('/team', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { name, email, role, skills, capacity_hours_per_day } = req.body as {
      name: string;
      email: string;
      role: string;
      skills?: string[];
      capacity_hours_per_day?: number;
    };

    if (!name || !role) {
      res.status(400).json({ error: 'name y role son requeridos' });
      return;
    }

    const member = await createTeamMember(user._id, {
      name,
      email: email ?? '',
      role,
      skills: skills ?? [],
      capacity_hours_per_day,
    });

    res.status(201).json({ member });
  } catch (err) {
    console.error('[Team] POST /team error:', err);
    res.status(500).json({ error: 'Error al crear el miembro' });
  }
});

router.put('/team/:id', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { id } = req.params;
    const { name, email, role, skills, capacity_hours_per_day } = req.body;

    const updated = await updateTeamMember(id, user._id, { name, email, role, skills, capacity_hours_per_day });
    if (!updated) {
      res.status(404).json({ error: 'Miembro no encontrado' });
      return;
    }

    res.json({ member: updated });
  } catch (err) {
    console.error('[Team] PUT /team/:id error:', err);
    res.status(500).json({ error: 'Error al actualizar el miembro' });
  }
});

router.delete('/team/:id', requireUser, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { id } = req.params;

    const deleted = await deleteTeamMember(id, user._id);
    if (!deleted) {
      res.status(404).json({ error: 'Miembro no encontrado' });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[Team] DELETE /team/:id error:', err);
    res.status(500).json({ error: 'Error al eliminar el miembro' });
  }
});

const SYSTEM_PROMPT = `Sos un analizador de CVs. Extraés información estructurada de currículos y la devolvés como JSON.
Devolvé ÚNICAMENTE un objeto JSON con estas claves (sin texto extra):
{
  "name": "nombre completo",
  "email": "email o cadena vacía si no hay",
  "role": "título o rol profesional principal (ej: Frontend Developer, Scrum Master, UX Designer)",
  "skills": ["array de skills técnicas y blandas relevantes, máximo 20, en el idioma original del CV"],
  "capacity_hours_per_day": 8,
  "summary": "una línea con la experiencia o perfil principal de la persona"
}
Reglas:
- skills: incluí tecnologías, herramientas, metodologías, idiomas y competencias relevantes
- role: el título más representativo que resume su perfil
- capacity_hours_per_day: 8 siempre, excepto si el CV indica part-time o freelance`;

// POST /team/parse-cv — extract team member data from a CV file or pasted text
router.post('/team/parse-cv', requireUser, async (req: Request, res: Response) => {
  try {
    const { cv_text, file_data, file_type } = req.body as {
      cv_text?: string;
      file_data?: string;   // base64-encoded file content
      file_type?: string;   // MIME type, e.g. "application/pdf" or "image/png"
    };

    if (!cv_text?.trim() && !file_data) {
      res.status(400).json({ error: 'Se requiere texto o archivo' });
      return;
    }

    const config = getConfig();
    const openai = new OpenAI({ apiKey: config.llm.openai.api_key, defaultHeaders: { 'Accept-Encoding': 'identity' } });

    let completion: Awaited<ReturnType<typeof openai.chat.completions.create>>;
    const mime = (file_type ?? '').toLowerCase();
    const isImage = mime.startsWith('image/');
    const isPdf   = mime.includes('pdf');

    if (file_data && isImage) {
      // ── Vision: let gpt-4o read the image directly ──────────────
      completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        response_format: { type: 'json_object' },
        temperature: 0.1,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${file_type};base64,${file_data}`, detail: 'high' },
            },
            {
              type: 'text',
              text: `${SYSTEM_PROMPT}\n\nAnalizá el CV que aparece en la imagen y devolvé el JSON.`,
            },
          ],
        }],
      });

    } else {
      // ── Text path: plain text OR PDF extracted via pdf-parse ─────
      let text = cv_text ?? '';

      if (file_data && isPdf) {
        // ESM-compatible dynamic require for the CJS pdf-parse module
        const { createRequire } = await import('module');
        const require = createRequire(import.meta.url);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>;
        const buffer = Buffer.from(file_data, 'base64');
        const parsed = await pdfParse(buffer);
        text = parsed.text;
        if (!text.trim()) {
          res.status(422).json({
            error: 'El PDF parece ser una imagen escaneada. Usá una imagen (PNG/JPG) o pegá el texto manualmente.',
          });
          return;
        }
      }

      completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        response_format: { type: 'json_object' },
        temperature: 0.1,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: `Analizá este CV:\n\n${text.slice(0, 12_000)}` },
        ],
      });
    }

    const raw = completion.choices[0]?.message?.content ?? '{}';
    let extracted: Record<string, unknown>;
    try { extracted = JSON.parse(raw); } catch {
      res.status(500).json({ error: 'El modelo devolvió un JSON inválido' });
      return;
    }

    console.log(`[Team] CV parsed → ${extracted.name ?? '?'}, ${(extracted.skills as string[] | undefined)?.length ?? 0} skills`);
    res.json({ member: extracted });
  } catch (err) {
    console.error('[Team] POST /team/parse-cv error:', err);
    res.status(500).json({ error: 'Error al analizar el CV' });
  }
});

export default router;
