import { config } from 'dotenv';
config();

import { drizzle } from 'drizzle-orm/neon-http';
import { neon, neonConfig } from '@neondatabase/serverless';
import * as schema from './schema';

// Configure Neon for better reliability in serverless environments
neonConfig.fetchConnectionCache = true; // Reuse connections
neonConfig.fetchEndpoint = (host) => {
  // Use the pooler endpoint for better connection handling
  // Neon pooler runs on port 5432, direct connections on 5433
  const poolHost = host.replace('-pooler', '').replace('.neon.tech', '-pooler.neon.tech');
  return `https://${poolHost}/sql`;
};

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