import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import axios from 'axios';
import { getConfig } from '../config.js';

interface JiraTicket {
  key: string;
  summary: string;
  priority: string;
  status: string;
  type?: string;
  url?: string;
}

function getJiraHeaders(email: string, apiToken: string): Record<string, string> {
  const encoded = Buffer.from(`${email}:${apiToken}`).toString('base64');
  return {
    Authorization: `Basic ${encoded}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

async function fetchTickets(
  server: string,
  email: string,
  apiToken: string,
  jql: string
): Promise<JiraTicket[]> {
  const headers = getJiraHeaders(email, apiToken);
  const url = `${server}/rest/api/3/search`;

  const res = await axios.get(url, {
    headers,
    params: {
      jql,
      maxResults: 50,
      fields: 'summary,priority,status,issuetype',
    },
  });

  const issues = res.data.issues ?? [];
  return issues.map((issue: Record<string, unknown>) => {
    const fields = issue.fields as Record<string, Record<string, string>>;
    return {
      key: String(issue.key),
      summary: fields.summary as unknown as string,
      priority: fields.priority?.name ?? 'None',
      status: fields.status?.name ?? '',
      type: fields.issuetype?.name ?? '',
      url: `${server}/browse/${issue.key}`,
    };
  });
}

export async function jiraRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /jira — in progress + open tickets
  fastify.get('/jira', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const config = getConfig();
      if (!config.jira) {
        return reply.send({ tickets: [], error: 'Jira not configured' });
      }

      const { server, email, api_token } = config.jira;
      const jql = 'assignee = currentUser() AND status in ("In Progress", "Open", "To Do") ORDER BY updated DESC';

      const tickets = await fetchTickets(server, email, api_token, jql);
      return reply.send({ tickets });
    } catch (err) {
      console.error('[Jira] GET /jira error:', err);
      return reply.status(500).send({ tickets: [], error: 'Failed to fetch Jira tickets' });
    }
  });

  // GET /jira/board — full board view
  fastify.get('/jira/board', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const config = getConfig();
      if (!config.jira) {
        return reply.send({ tickets: [], error: 'Jira not configured' });
      }

      const { server, email, api_token } = config.jira;
      const jql = 'assignee = currentUser() ORDER BY status ASC, updated DESC';

      const tickets = await fetchTickets(server, email, api_token, jql);
      return reply.send({ tickets });
    } catch (err) {
      console.error('[Jira] GET /jira/board error:', err);
      return reply.status(500).send({ tickets: [], error: 'Failed to fetch Jira board' });
    }
  });
}
