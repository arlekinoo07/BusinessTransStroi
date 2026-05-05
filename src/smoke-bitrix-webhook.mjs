import { adaptBitrixWebhookPayload } from './bitrix-webhook-adapter.mjs';
import { bitrixWebhookFixtures } from './fixtures/bitrix-webhook-events.mjs';
import { createRepository } from './repositories/opportunity-repository.mjs';

const repository = createRepository();

async function main() {
  const adapted = bitrixWebhookFixtures.map(adaptBitrixWebhookPayload);

  for (const event of adapted) {
    await repository.saveIngestEvent(event);
  }

  const processResult = await repository.processPendingIngestEvents(20);
  const opportunities = await repository.listOpportunities();
  const opportunity = opportunities.find((item) => item.id === '9100' || item.bitrix_deal_id === '9100') ?? null;

  console.log(JSON.stringify({
    adapted_events: adapted.map((item) => ({
      entity_type: item.entity_type,
      entity_id: item.entity_id,
      event_type: item.event_type,
    })),
    processed_count: processResult.processed_count,
    webhook_opportunity_found: Boolean(opportunity),
    webhook_opportunity_company: opportunity?.company?.raw_value ?? null,
    webhook_opportunity_object: opportunity?.project_object?.raw_value ?? null,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
