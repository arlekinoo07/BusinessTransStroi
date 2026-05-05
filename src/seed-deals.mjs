import 'dotenv/config';

const { BITRIX24_WEBHOOK_URL } = process.env;

if (!BITRIX24_WEBHOOK_URL) {
  throw new Error('Missing required environment variable: BITRIX24_WEBHOOK_URL');
}

function createDealPayload(index, stage, scores) {
  const average = (scores.need + scores.time + scores.spec + scores.access + scores.money + scores.fit) / 6;
  const maturityPercent = Math.round((average / 5) * 100);

  return {
    TITLE: `Тестовая сделка приоритет #${index}`,
    TYPE_ID: 'SALE',
    STAGE_ID: 'NEW',
    CURRENCY_ID: 'RUB',
    OPPORTUNITY: '0',
    COMMENTS: `Создано через CodeX. Приоритетность вынесена в отдельные поля сделки. Категория зрелости: ${stage}. Вектор зрелости: ${maturityPercent}%.`,
    UF_CRM_NEED_SCORE: scores.need,
    UF_CRM_TIME_SCORE: scores.time,
    UF_CRM_SPEC_SCORE: scores.spec,
    UF_CRM_ACCESS_SCORE: scores.access,
    UF_CRM_MONEY_SCORE: scores.money,
    UF_CRM_FIT_SCORE: scores.fit,
    UF_CRM_MATURITY_PERCENT: maturityPercent,
    UF_CRM_MATURITY_STAGE: stage,
  };
}

function stageAndScores(index) {
  if (index <= 60) {
    return {
      stage: 'Горячая',
      scores: {
        need: 4 + (index % 2),
        time: 4 + ((index + 1) % 2),
        spec: 4 + ((index + 2) % 2),
        access: 4 + ((index + 3) % 2),
        money: 4 + ((index + 4) % 2),
        fit: 4 + ((index + 5) % 2),
      },
    };
  }

  if (index <= 150) {
    return {
      stage: 'В процессе',
      scores: {
        need: 2 + (index % 3),
        time: 2 + ((index + 1) % 3),
        spec: 2 + ((index + 2) % 3),
        access: 2 + ((index + 3) % 3),
        money: 2 + ((index + 4) % 3),
        fit: 2 + ((index + 2) % 3),
      },
    };
  }

  return {
    stage: 'Холодная',
    scores: {
      need: index % 2,
      time: (index + 1) % 2,
      spec: (index + 2) % 2,
      access: (index + 3) % 2,
      money: (index + 1) % 2,
      fit: (index + 2) % 2,
    },
  };
}

async function batchCreate(deals, offset) {
  const cmd = {};

  deals.forEach((deal, index) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(deal)) {
      params.append(`fields[${key}]`, String(value));
    }
    cmd[`deal_${offset + index + 1}`] = `crm.deal.add?${params.toString()}`;
  });

  const response = await fetch(`${BITRIX24_WEBHOOK_URL}/batch.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ halt: 0, cmd }),
  });

  const json = await response.json();
  if (json.error) {
    throw new Error(`${json.error} ${json.error_description ?? ''}`.trim());
  }

  return json.result.result;
}

async function main() {
  const deals = [];
  const stats = { 'Горячая': 0, 'В процессе': 0, 'Холодная': 0 };

  for (let index = 1; index <= 200; index += 1) {
    const { stage, scores } = stageAndScores(index);
    deals.push(createDealPayload(index, stage, scores));
    stats[stage] += 1;
  }

  const createdIds = [];
  for (let offset = 0; offset < deals.length; offset += 50) {
    const chunk = deals.slice(offset, offset + 50);
    const result = await batchCreate(chunk, offset);
    createdIds.push(...Object.values(result));
    console.log(`Created ${createdIds.length}/${deals.length}`);
  }

  console.log(
    JSON.stringify(
      {
        created: createdIds.length,
        stats,
        firstIds: createdIds.slice(0, 5),
        lastIds: createdIds.slice(-5),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
