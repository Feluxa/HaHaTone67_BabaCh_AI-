import { z } from "zod";

export const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  SANDBOX_URL: z.string().url().default("http://127.0.0.1:8000"),
  TEAM_NAME: z.string().min(1).default("team-alpha"),
  GIGACHAT_API_KEY: z.string().optional(),
  GIGACHAT_AUTH_URL: z
    .string()
    .url()
    .default("https://ngw.devices.sberbank.ru:9443/api/v2/oauth"),
  GIGACHAT_API_URL: z
    .string()
    .url()
    .default("https://gigachat.devices.sberbank.ru/api/v1/chat/completions"),
  GIGACHAT_MODEL: z.string().default("GigaChat-2-Max"),
  GIGACHAT_SCOPE: z.string().min(1).default("GIGACHAT_API_PERS"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type AppEnv = z.infer<typeof EnvSchema>;

export function getEnv(): AppEnv {
  return EnvSchema.parse(process.env);
}
