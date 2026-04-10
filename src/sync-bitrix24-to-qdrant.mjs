import 'dotenv/config';

import { QdrantClient } from '@qdrant/js-client-rest';
import { pipeline, env as transformersEnv } from '@xenova/transformers';

const {
  BITRIX24_WEBHOOK_URL,
  QDRANT_URL,
  QDRANT_API_KEY,
  QDRANT_COLLECTION = 'bitrix24_records',
  EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
} = process.env;

const REQUIRED_ENV_VARS = [
  'BITRIX24_WEBHOOK_URL',
  'QDRANT_URL',
];

for (const name of REQUIRED_ENV_VARS) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

const qdrant = new QdrantClient({
  url: QDRANT_URL,
  apiKey: QDRANT_API_KEY || undefined,
});

transformersEnv.allowLocalModels = true;
transformersEnv.useBrowserCache = false;

let embeddingPipelinePromise;

async function getEmbeddingPipeline() {
  if (!embeddingPipelinePromise) {
    console.log(`Loading embedding model: ${EMBEDDING_MODEL}`);
    embeddingPipelinePromise = pipeline('feature-extraction', EMBEDDING_MODEL);
  }

  return embeddingPipelinePromise;
}

async function bitrixList(method, select = ['*', 'UF_*']) {
  const items = [];
  let start = 0;

  while (start !== null) {
    const url = new URL(`${BITRIX24_WEBHOOK_URL}/${method}.json`);
    url.searchParams.set('start', String(start));
    for (const field of select) {
      url.searchParams.append('select[]', field);
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Bitrix24 request failed for ${method}: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    if (payload.error) {
      throw new Error(`Bitrix24 API error for ${method}: ${payload.error} ${payload.error_description ?? ''}`.trim());
    }

    items.push(...(payload.result ?? []));
    start = typeof payload.next === 'number' ? payload.next : null;
  }

  return items;
}

function cleanupValue(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (Array.isArray(value)) {
    const nested = value.map(cleanupValue).filter(Boolean);
    return nested.length ? nested.join(', ') : null;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .map(([key, nested]) => {
        const cleaned = cleanupValue(nested);
        return cleaned ? `${key}: ${cleaned}` : null;
      })
      .filter(Boolean);

    return entries.length ? entries.join('; ') : null;
  }

  return String(value).replace(/\s+/g, ' ').trim() || null;
}

function toTextDocument(entityType, record) {
  const labels = entityType === 'company'
    ? {
        title: 'Компания',
        id: record.ID,
        name: record.TITLE,
      }
    : {
        title: 'Сделка',
        id: record.ID,
        name: record.TITLE,
      };

  const preferredFields = [
    'TITLE',
    'COMPANY_TITLE',
    'TYPE_ID',
    'STAGE_ID',
    'OPPORTUNITY',
    'CURRENCY_ID',
    'ASSIGNED_BY_ID',
    'CONTACT_ID',
    'COMPANY_ID',
    'CITY',
    'ADDRESS',
    'ADDRESS_CITY',
    'ADDRESS_REGION',
    'ADDRESS_PROVINCE',
    'ADDRESS_COUNTRY',
    'COMMENTS',
    'SOURCE_ID',
    'SOURCE_DESCRIPTION',
    'BEGINDATE',
    'CLOSEDATE',
  ];

  const lines = [`Тип: ${labels.title}`, `ID: ${labels.id}`];
  if (labels.name) {
    lines.push(`Название: ${labels.name}`);
  }

  const seen = new Set(['ID']);
  for (const field of preferredFields) {
    const cleaned = cleanupValue(record[field]);
    if (cleaned) {
      lines.push(`${field}: ${cleaned}`);
      seen.add(field);
    }
  }

  for (const [field, value] of Object.entries(record)) {
    if (seen.has(field)) {
      continue;
    }

    const cleaned = cleanupValue(value);
    if (cleaned) {
      lines.push(`${field}: ${cleaned}`);
    }
  }

  return lines.join('\n');
}

function toPoint(entityType, record, vector) {
  const numericId = Number(record.ID);

  return {
    id: entityType === 'company' ? numericId : 1_000_000 + numericId,
    vector,
    payload: {
      entity_type: entityType,
      bitrix_id: String(record.ID),
      title: record.TITLE ?? '',
      text: toTextDocument(entityType, record),
      source: 'bitrix24',
      raw: record,
    },
  };
}

async function createEmbeddings(texts) {
  const extractor = await getEmbeddingPipeline();
  const vectors = [];

  for (const [index, text] of texts.entries()) {
    console.log(`Embedding ${index + 1}/${texts.length}`);
    const output = await extractor(text, {
      pooling: 'mean',
      normalize: true,
    });
    vectors.push(Array.from(output.data));
  }

  return vectors;
}

async function ensureCollection(vectorSize) {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((collection) => collection.name === QDRANT_COLLECTION);

  if (exists) {
    return;
  }

  await qdrant.createCollection(QDRANT_COLLECTION, {
    vectors: {
      size: vectorSize,
      distance: 'Cosine',
    },
  });
}

async function upsertPoints(points) {
  const batchSize = 50;
  for (let offset = 0; offset < points.length; offset += batchSize) {
    const batch = points.slice(offset, offset + batchSize);
    await qdrant.upsert(QDRANT_COLLECTION, {
      wait: true,
      points: batch,
    });
  }
}

async function main() {
  const [companies, deals] = await Promise.all([
    bitrixList('crm.company.list'),
    bitrixList('crm.deal.list'),
  ]);

  console.log(`Fetched ${companies.length} companies and ${deals.length} deals from Bitrix24.`);

  const records = [
    ...companies.map((record) => ({ entityType: 'company', record })),
    ...deals.map((record) => ({ entityType: 'deal', record })),
  ];

  if (!records.length) {
    console.log('No Bitrix24 records found.');
    return;
  }

  const texts = records.map(({ entityType, record }) => toTextDocument(entityType, record));
  const vectors = await createEmbeddings(texts);

  if (!vectors.length) {
    throw new Error('No embeddings were generated.');
  }

  console.log(`Ensuring Qdrant collection ${QDRANT_COLLECTION}.`);
  await ensureCollection(vectors[0].length);

  const points = records.map(({ entityType, record }, index) =>
    toPoint(entityType, record, vectors[index]),
  );

  console.log(`Uploading ${points.length} points to Qdrant.`);
  await upsertPoints(points);

  console.log(
    JSON.stringify(
      {
        collection: QDRANT_COLLECTION,
        companies: companies.length,
        deals: deals.length,
        total_points: points.length,
        embedding_model: EMBEDDING_MODEL,
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
