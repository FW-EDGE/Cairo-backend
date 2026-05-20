import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { getConfig, reloadConfig } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '../../../backend/config.yaml');

export async function configRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /config/llm
  fastify.get('/config/llm', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const config = getConfig();
      const providers: Record<string, unknown> = {
        openai: {
          model: config.llm.openai.model,
          has_key: Boolean(config.llm.openai.api_key),
        },
      };

      if (config.llm.grok) {
        providers.grok = {
          model: config.llm.grok.model,
          base_url: config.llm.grok.base_url,
          has_key: Boolean(config.llm.grok.api_key),
        };
      }

      return reply.send({
        current_provider: config.llm.provider,
        providers,
      });
    } catch (err) {
      console.error('[Config] GET /config/llm error:', err);
      return reply.status(500).send({ error: 'Failed to read LLM config' });
    }
  });

  // POST /config/llm
  fastify.post('/config/llm', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { provider } = request.body as { provider: string };

      if (!provider) {
        return reply.status(400).send({ error: 'provider is required' });
      }

      // Read current YAML
      const raw = readFileSync(CONFIG_PATH, 'utf-8');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed = yaml.load(raw) as any;

      parsed.llm.provider = provider;

      const newYaml = yaml.dump(parsed, { lineWidth: 120 });
      writeFileSync(CONFIG_PATH, newYaml, 'utf-8');

      // Reload cached config
      reloadConfig();

      return reply.send({ ok: true, provider });
    } catch (err) {
      console.error('[Config] POST /config/llm error:', err);
      return reply.status(500).send({ error: 'Failed to update LLM config' });
    }
  });
}
