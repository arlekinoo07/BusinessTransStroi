import 'dotenv/config';

import { opportunityStore } from '../dss/sample-data.mjs';
import { PostgresOpportunityRepository } from '../repositories/postgres-opportunity-repository.mjs';

async function main() {
  const repository = new PostgresOpportunityRepository();
  await repository.seedFromSamples(Array.from(opportunityStore.values()));
  console.log(`Seeded ${opportunityStore.size} opportunities into PostgreSQL.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
