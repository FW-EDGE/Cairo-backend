import 'dotenv/config';

export interface AppConfig {
  mongodb: {
    uri: string;
    database: string;
    collection: string;
    vector_index: string;
  };
  auth: {
    jwt_secret: string;
    google_client_id: string;
    google_client_secret: string;
    redirect_uri: string;
    frontend_url: string;
  };
  llm: {
    provider: string;
    openai: {
      api_key: string;
      model: string;
    };
    grok?: {
      api_key: string;
      model: string;
      base_url: string;
    };
  };
  jira?: {
    server: string;
    email: string;
    api_token: string;
  };
}

function require(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

let cachedConfig: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  cachedConfig = {
    mongodb: {
      uri:          require('MONGODB_URI'),
      database:     require('MONGODB_DATABASE'),
      collection:   process.env.MONGODB_COLLECTION   ?? 'cairo_embeddings',
      vector_index: process.env.MONGODB_VECTOR_INDEX ?? 'vector_index',
    },
    auth: {
      jwt_secret:           require('JWT_SECRET'),
      google_client_id:     require('GOOGLE_CLIENT_ID'),
      google_client_secret: require('GOOGLE_CLIENT_SECRET'),
      redirect_uri:         require('GOOGLE_REDIRECT_URI'),
      frontend_url:         process.env.FRONTEND_URL ?? 'http://localhost:5174',
    },
    llm: {
      provider: process.env.LLM_PROVIDER ?? 'openai',
      openai: {
        api_key: require('OPENAI_API_KEY'),
        model:   process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      },
      ...(process.env.GROK_API_KEY ? {
        grok: {
          api_key:  process.env.GROK_API_KEY,
          model:    process.env.GROK_MODEL    ?? 'grok-beta',
          base_url: process.env.GROK_BASE_URL ?? 'https://api.x.ai/v1',
        },
      } : {}),
    },
    ...(process.env.JIRA_SERVER ? {
      jira: {
        server:    process.env.JIRA_SERVER!,
        email:     process.env.JIRA_EMAIL     ?? '',
        api_token: process.env.JIRA_API_TOKEN ?? '',
      },
    } : {}),
  };

  return cachedConfig;
}

export function reloadConfig(): AppConfig {
  cachedConfig = null;
  return getConfig();
}
