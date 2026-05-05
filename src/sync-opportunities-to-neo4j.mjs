import 'dotenv/config';

import { createRepository } from './repositories/opportunity-repository.mjs';
import { syncRepositoryToNeo4j } from './services/neo4j-graph-service.mjs';

async function main() {
  const repository = createRepository();
  const result = await syncRepositoryToNeo4j(repository);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
