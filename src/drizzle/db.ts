import { config } from 'dotenv';
config();

import { drizzle } from 'drizzle-orm/neon-http';
import { neon, neonConfig } from '@neondatabase/serverless';
import * as schema from './schema';

// Configure fetch with longer timeout for Railway -> Neon connections
neonConfig.fetchFunction = async (url, options) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
};

const sql = neon(process.env.DATABASE_URL!);

export const db = drizzle(sql, { schema });

export type DbType = typeof db;