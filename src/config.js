import 'dotenv/config';
import { z } from 'zod';

const envBoolean = z.preprocess((value) => {
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  }
  return value;
}, z.boolean());

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().optional(),
  DISCORD_MESSAGE_CONTENT_INTENT: envBoolean.default(false),
  DISCORD_GUILD_MEMBERS_INTENT: envBoolean.default(false),
  PORT: z.coerce.number().default(3000),
  DASHBOARD_ADMIN_KEY: z.string().default('dev-admin-key'),
  DATA_DIR: z.string().default('./data'),
  AI_PROVIDER: z.enum(['groq', 'ollama', 'openai-compatible', 'disabled']).default('groq'),
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default('llama-3.1-8b-instant'),
  OLLAMA_BASE_URL: z.string().url().default('http://192.168.1.52:11434'),
  OLLAMA_MODEL: z.string().default('llama3.2:3b'),
  OPENAI_COMPAT_BASE_URL: z.string().url().default('http://192.168.1.52:8080/v1'),
  OPENAI_COMPAT_MODEL: z.string().default('tinyllama'),
  OPENAI_COMPAT_API_KEY: z.string().default('local'),
  AI_MAX_HISTORY_MESSAGES: z.coerce.number().int().min(1).max(50).default(20),
  AI_AUTO_REPLY: envBoolean.default(true)
});

export const config = schema.parse(process.env);
