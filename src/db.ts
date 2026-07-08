import { config } from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

function findEnvFile(startDir: string): string | undefined {
  let currentDir = startDir;
  while (currentDir !== path.dirname(currentDir)) {
    const envPath = path.join(currentDir, ".env");
    if (existsSync(envPath)) {
      return envPath;
    }
    currentDir = path.dirname(currentDir);
  }
  return undefined;
}

const envPath = findEnvFile(import.meta.dirname);
if (envPath) {
  config({ path: envPath });
}

export const db = new PrismaClient();
export * from "@prisma/client";
