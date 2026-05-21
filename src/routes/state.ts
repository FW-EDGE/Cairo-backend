import { Router, Request, Response } from 'express';
import { exec } from 'child_process';
import {
  cairoState,
  broadcastState,
  broadcastJson,
  updateState,
  addLog,
  lastHeartbeat,
} from '../websocket.js';

const router = Router();

// POST /heartbeat
router.post('/heartbeat', (_req: Request, res: Response) => {
  lastHeartbeat.value = new Date();
  if (cairoState.status === 'offline') {
    updateState('online');
    broadcastState();
  }
  res.json({ ok: true });
});

// POST /state
router.post('/state', (req: Request, res: Response) => {
  try {
    const body = req.body as Partial<{ status: string; last_input: string; last_response: string }>;
    updateState(body.status, body.last_input, body.last_response);
    broadcastState();
    res.json({ ok: true });
  } catch (err) {
    console.error('[State] POST /state error:', err);
    res.status(500).json({ error: 'Failed to update state' });
  }
});

// GET /state
router.get('/state', (_req: Request, res: Response) => {
  res.json(cairoState);
});

// POST /log
router.post('/log', (req: Request, res: Response) => {
  try {
    const { message } = req.body as { message: string };
    if (!message) { res.status(400).json({ error: 'message is required' }); return; }
    addLog(message);
    res.json({ ok: true });
  } catch (err) {
    console.error('[State] POST /log error:', err);
    res.status(500).json({ error: 'Failed to add log' });
  }
});

// POST /cairo/highlight
router.post('/cairo/highlight', (req: Request, res: Response) => {
  broadcastJson({ type: 'highlight_nodes', ...req.body });
  res.json({ ok: true });
});

// POST /cairo/show
router.post('/cairo/show', (req: Request, res: Response) => {
  broadcastJson({ type: 'show_file', ...req.body });
  res.json({ ok: true });
});

// POST /ui/expand
router.post('/ui/expand', (req: Request, res: Response) => {
  broadcastJson({ type: 'expand_panel', ...req.body });
  res.json({ ok: true });
});

// POST /waveform
router.post('/waveform', (req: Request, res: Response) => {
  const { amplitude } = req.body as { amplitude: number };
  broadcastJson({ type: 'waveform', amplitude });
  res.json({ ok: true });
});

// POST /cairo/run
router.post('/cairo/run', (_req: Request, res: Response) => {
  try {
    cairoState.logs = [];
    updateState('starting');
    broadcastState();

    const cmd = `start "CAIRO Agent" /D "C:\\Jarvis\\agent" "C:\\Jarvis\\jarvis\\venv\\Scripts\\python.exe" "main.py"`;
    exec(cmd, { shell: 'cmd.exe' }, (err) => {
      if (err) {
        console.error('[State] Failed to start CAIRO agent:', err);
        updateState('error');
        addLog(`Error starting agent: ${err.message}`);
      }
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[State] POST /cairo/run error:', err);
    res.status(500).json({ error: 'Failed to run CAIRO agent' });
  }
});

export default router;
