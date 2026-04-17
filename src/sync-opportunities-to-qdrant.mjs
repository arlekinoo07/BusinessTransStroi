import 'dotenv/config';

import { createRepository } from './repositories/opportunity-repository.mjs';
import { syncRepositoryToQdrant } from './services/qdrant-vector-service.mjs';

async function main() {
  const repository = createRepository();
  const result = await syncRepositoryToQdrant(repository);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
