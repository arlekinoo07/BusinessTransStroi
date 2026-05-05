import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { query } from './postgres.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const schemaPath = path.resolve(__dirname, '../../db/schema.sql');
  const schemaSql = await fs.readFile(schemaPath, 'utf8');
  await query(schemaSql);
  console.log(`Applied schema from ${schemaPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
