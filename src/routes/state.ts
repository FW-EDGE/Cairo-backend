import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { exec } from 'child_process';
import {
  cairoState,
  connectedClients,
  broadcastState,
  broadcastJson,
  updateState,
  addLog,
  lastHeartbeat,
} from '../websocket.js';

export async function stateRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /heartbeat
  fastify.post('/heartbeat', async (_request: FastifyRequest, reply: FastifyReply) => {
    lastHeartbeat.value = new Date();
    if (cairoState.status === 'offline') {
      updateState('online');
      broadcastState();
    }
    return reply.send({ ok: true });
  });

  // POST /state
  fastify.post('/state', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = request.body as Partial<{
        status: string;
        last_input: string;
        last_response: string;
      }>;
      updateState(body.status, body.last_input, body.last_response);
      broadcastState();
      return reply.send({ ok: true });
    } catch (err) {
      console.error('[State] POST /state error:', err);
      return reply.status(500).send({ error: 'Failed to update state' });
    }
  });

  // GET /state
  fastify.get('/state', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(cairoState);
  });

  // POST /log
  fastify.post('/log', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { message } = request.body as { message: string };
      if (!message) {
        return reply.status(400).send({ error: 'message is required' });
      }
      addLog(message);
      return reply.send({ ok: true });
    } catch (err) {
      console.error('[State] POST /log error:', err);
      return reply.status(500).send({ error: 'Failed to add log' });
    }
  });

  // POST /cairo/highlight
  fastify.post('/cairo/highlight', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown>;
    broadcastJson({ type: 'highlight_nodes', ...body });
    return reply.send({ ok: true });
  });

  // POST /cairo/show
  fastify.post('/cairo/show', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown>;
    broadcastJson({ type: 'show_file', ...body });
    return reply.send({ ok: true });
  });

  // POST /ui/expand
  fastify.post('/ui/expand', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown>;
    broadcastJson({ type: 'expand_panel', ...body });
    return reply.send({ ok: true });
  });

  // POST /waveform
  fastify.post('/waveform', async (request: FastifyRequest, reply: FastifyReply) => {
    const { amplitude } = request.body as { amplitude: number };
    broadcastJson({ type: 'waveform', amplitude });
    return reply.send({ ok: true });
  });

  // POST /cairo/run
  fastify.post('/cairo/run', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Reset logs and update state
      cairoState.logs = [];
      updateState('starting');
      broadcastState();

      // Spawn agent process on Windows
      const cmd = `start "CAIRO Agent" /D "C:\\Jarvis\\agent" "C:\\Jarvis\\jarvis\\venv\\Scripts\\python.exe" "main.py"`;
      exec(cmd, { shell: 'cmd.exe' }, (err) => {
        if (err) {
          console.error('[State] Failed to start CAIRO agent:', err);
          updateState('error');
          addLog(`Error starting agent: ${err.message}`);
        }
      });

      return reply.send({ ok: true });
    } catch (err) {
      console.error('[State] POST /cairo/run error:', err);
      return reply.status(500).send({ error: 'Failed to run CAIRO agent' });
    }
  });

  // WS /ws
  fastify.get('/ws', { websocket: true }, (connection, _req) => {
    const socket = connection.socket;
    // Send current state on connect
    socket.send(JSON.stringify({ type: 'state', ...cairoState }));
    connectedClients.add(socket);

    socket.on('close', () => {
      connectedClients.delete(socket);
    });

    socket.on('error', (err: Error) => {
      console.error('[WS] Client error:', err);
      connectedClients.delete(socket);
    });
  });
}
