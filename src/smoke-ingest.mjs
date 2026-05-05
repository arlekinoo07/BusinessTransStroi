import { createRepository } from './repositories/opportunity-repository.mjs';

const repository = createRepository();

const demoEvents = [
  {
    source: 'bitrix24',
    entity_type: 'company',
    entity_id: '3001',
    event_type: 'updated',
    occurred_at: new Date().toISOString(),
    payload: {
      fields: {
        ID: '3001',
        TITLE: 'ООО БТС Девелопмент',
      },
    },
  },
  {
    source: 'bitrix24',
    entity_type: 'deal',
    entity_id: '9001',
    event_type: 'updated',
    occurred_at: new Date().toISOString(),
    payload: {
      fields: {
        ID: '9001',
        TITLE: 'Автокран на объект Север',
        COMPANY_ID: '3001',
        COMPANY_TITLE: 'ООО БТС Девелопмент',
        CONTACT_ID: '4001',
        COMMENTS: 'Объект: БЦ Север. Техника: автокран 25т. Срочно нужен договор завтра утром.',
        STAGE_ID: 'PREPARATION',
        BEGINDATE: new Date(Date.now() + 24 * 3_600_000).toISOString(),
        UF_CRM_DURATION_DAYS: '7',
      },
    },
  },
  {
    source: 'bitrix24',
    entity_type: 'comment',
    entity_id: '7001',
    event_type: 'created',
    occurred_at: new Date().toISOString(),
    payload: {
      fields: {
        ID: '7001',
        DEAL_ID: '9001',
        COMMENT: 'Клиент просит КП сегодня до 15:00, объект подтвержден.',
      },
    },
  },
  {
    source: 'bitrix24',
    entity_type: 'activity',
    entity_id: '7002',
    event_type: 'created',
    occurred_at: new Date().toISOString(),
    payload: {
      fields: {
        ID: '7002',
        COMPANY_ID: '3001',
        DESCRIPTION: 'Объект: БЦ Север. Клиент подтверждает готовность к КП сегодня.',
      },
    },
  },
];

async function main() {
  for (const event of demoEvents) {
    await repository.saveIngestEvent(event);
  }

  const pendingBefore = await repository.listPendingIngestEvents(20);
  const processed = await repository.processPendingIngestEvents(20);
  const opportunities = await repository.listOpportunities();
  const ingestedOpportunity = opportunities.find((item) => item.id === '9001' || item.bitrix_deal_id === '9001') ?? null;

  console.log(JSON.stringify({
    pending_before: pendingBefore.length,
    processed_count: processed.processed_count,
    processed: processed.processed,
    opportunity_count: opportunities.length,
    ingested_opportunity: ingestedOpportunity,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
