import { z } from "zod";

export const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  SANDBOX_URL: z.string().url().default("http://127.0.0.1:8000"),
  TEAM_NAME: z.string().min(1).default("team-alpha"),
  GIGACHAT_API_KEY: z.string().optional(),
  GIGACHAT_MODEL: z.string().default("GigaChat-2-Pro"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type AppEnv = z.infer<typeof EnvSchema>;

export function getEnv(): AppEnv {
  return EnvSchema.parse(process.env);
}
