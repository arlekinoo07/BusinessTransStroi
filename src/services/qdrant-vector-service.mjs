import 'dotenv/config';

import { QdrantClient } from '@qdrant/js-client-rest';
import { pipeline, env as transformersEnv } from '@xenova/transformers';

transformersEnv.allowLocalModels = true;
transformersEnv.useBrowserCache = false;

const {
  QDRANT_URL,
  QDRANT_API_KEY,
  EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  QDRANT_COLLECTION_DEAL_EVENTS = 'deal_events_vectors',
  QDRANT_COLLECTION_WON_DEALS = 'won_deals_vectors',
  QDRANT_COLLECTION_LOST_DEALS = 'lost_deals_vectors',
  QDRANT_COLLECTION_COMPETITOR_MENTIONS = 'competitor_mentions_vectors',
  QDRANT_COLLECTION_CONTACT_PERSON = 'contact_person_vectors',
  QDRANT_COLLECTION_OBJECT_HISTORY = 'object_history_vectors',
} = process.env;

const COLLECTIONS = {
  deal_events: QDRANT_COLLECTION_DEAL_EVENTS,
  won_deals: QDRANT_COLLECTION_WON_DEALS,
  lost_deals: QDRANT_COLLECTION_LOST_DEALS,
  competitor_mentions: QDRANT_COLLECTION_COMPETITOR_MENTIONS,
  contact_person: QDRANT_COLLECTION_CONTACT_PERSON,
  object_history: QDRANT_COLLECTION_OBJECT_HISTORY,
};

let extractorPromise;
let clientInstance;

export function hasQdrantConfig() {
  return Boolean(QDRANT_URL);
}

export function getQdrantCollections() {
  return { ...COLLECTIONS };
}

function getQdrantClient() {
  if (!hasQdrantConfig()) {
    return null;
  }

  if (!clientInstance) {
    clientInstance = new QdrantClient({
      url: QDRANT_URL,
      apiKey: QDRANT_API_KEY || undefined,
    });
  }

  return clientInstance;
}

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', EMBEDDING_MODEL);
  }

  return extractorPromise;
}

export async function createEmbedding(text) {
  const extractor = await getExtractor();
  const output = await extractor(text, {
    pooling: 'mean',
    normalize: true,
  });
  return Array.from(output.data);
}

function buildOpportunityText(opportunity) {
  return [
    `company: ${opportunity.company?.raw_value ?? ''}`,
    `object: ${opportunity.project_object?.raw_value ?? ''}`,
    `equipment: ${opportunity.equipment_type?.normalized_value ?? opportunity.equipment_type?.raw_value ?? ''}`,
    `stage: ${opportunity.commercial_stage ?? ''}`,
    `next_step: ${opportunity.next_step?.description ?? ''}`,
    `margin: ${opportunity.economic_assessment?.expected_margin_percent ?? ''}`,
    ...(opportunity.technical_requirements ?? []),
    ...(opportunity.communication_events ?? []).slice(0, 5).map((item) => item.summary ?? item.text ?? ''),
  ].filter(Boolean).join('\n');
}

function buildObjectHistoryText(opportunity) {
  return [
    `object: ${opportunity.project_object?.raw_value ?? ''}`,
    `company: ${opportunity.company?.raw_value ?? ''}`,
    `equipment: ${opportunity.equipment_type?.normalized_value ?? opportunity.equipment_type?.raw_value ?? ''}`,
    `stage: ${opportunity.commercial_stage ?? ''}`,
    ...(opportunity.communication_events ?? []).slice(0, 3).map((item) => item.text ?? item.summary ?? ''),
  ].filter(Boolean).join('\n');
}

function buildContactText(opportunity) {
  return [
    `contact: ${opportunity.contact_person?.raw_value ?? ''}`,
    `role: ${opportunity.contact_person?.role ?? ''}`,
    `company: ${opportunity.company?.raw_value ?? ''}`,
    `object: ${opportunity.project_object?.raw_value ?? ''}`,
    `decision_access: ${opportunity.decision_access_status ?? ''}`,
  ].filter(Boolean).join('\n');
}

function buildCompetitorMentionText(opportunity, event) {
  return [
    `company: ${opportunity.company?.raw_value ?? ''}`,
    `object: ${opportunity.project_object?.raw_value ?? ''}`,
    `event: ${event.summary ?? ''}`,
    `text: ${event.text ?? ''}`,
  ].filter(Boolean).join('\n');
}

function makePointId(prefix, value) {
  return `${prefix}:${String(value)}`;
}

function makePayloadBase(opportunity) {
  return {
    opportunity_id: opportunity.id,
    bitrix_deal_id: opportunity.bitrix_deal_id ?? null,
    company: opportunity.company?.raw_value ?? null,
    object: opportunity.project_object?.raw_value ?? null,
    equipment_type: opportunity.equipment_type?.normalized_value ?? opportunity.equipment_type?.raw_value ?? null,
    commercial_stage: opportunity.commercial_stage ?? null,
    decision_access_status: opportunity.decision_access_status ?? null,
  };
}

async function ensureCollection(name, vectorSize) {
  const client = getQdrantClient();
  if (!client) return;

  const collections = await client.getCollections();
  const exists = collections.collections.some((item) => item.name === name);
  if (exists) return;

  await client.createCollection(name, {
    vectors: {
      size: vectorSize,
      distance: 'Cosine',
    },
  });
}

async function upsertPoints(collectionName, points) {
  const client = getQdrantClient();
  if (!client || !points.length) {
    return;
  }

  const batchSize = 10;
  for (let offset = 0; offset < points.length; offset += batchSize) {
    await client.upsert(collectionName, {
      wait: false,
      points: points.slice(offset, offset + batchSize),
    });
  }
}

function collectCompetitorMentionEvents(opportunity) {
  return (opportunity.communication_events ?? []).filter((event) =>
    /конкурент|competitor/i.test(`${event.summary ?? ''} ${event.text ?? ''}`),
  );
}

export async function syncRepositoryToQdrant(repository) {
  if (!hasQdrantConfig()) {
    return {
      enabled: false,
      reason: 'QDRANT_URL is not configured',
      collections: getQdrantCollections(),
    };
  }

  const opportunities = await repository.listOpportunities();
  if (!opportunities.length) {
    return {
      enabled: true,
      opportunities: 0,
      collections: getQdrantCollections(),
      synced: {},
    };
  }

  const probeVector = await createEmbedding('bts dss vector probe');
  const vectorSize = probeVector.length;
  const collectionNames = Object.values(COLLECTIONS);
  for (const name of collectionNames) {
    await ensureCollection(name, vectorSize);
  }

  const dealEventPoints = [];
  const wonDealPoints = [];
  const lostDealPoints = [];
  const objectHistoryPoints = [];
  const contactPoints = [];
  const competitorPoints = [];

  for (const opportunity of opportunities) {
    const basePayload = makePayloadBase(opportunity);
    const eventTexts = (opportunity.communication_events ?? [])
      .map((event) => ({
        event,
        text: [
          buildOpportunityText(opportunity),
          event.summary ?? '',
          event.text ?? '',
        ].filter(Boolean).join('\n'),
      }))
      .filter((item) => item.text.trim());

    for (const { event, text } of eventTexts) {
      const vector = await createEmbedding(text);
      dealEventPoints.push({
        id: makePointId('deal-event', event.id ?? `${opportunity.id}:${event.datetime ?? Date.now()}`),
        vector,
        payload: {
          ...basePayload,
          entity_type: 'deal_event',
          event_type: event.type ?? null,
          channel: event.channel ?? null,
          text,
          title: event.summary ?? `Event ${event.id ?? ''}`.trim(),
        },
      });
    }

    const opportunityText = buildOpportunityText(opportunity);
    if (opportunityText.trim()) {
      const vector = await createEmbedding(opportunityText);
      const dealPayload = {
        ...basePayload,
        entity_type: 'deal',
        title: opportunity.company?.raw_value ?? `Opportunity ${opportunity.id}`,
        text: opportunityText,
      };

      if (opportunity.commercial_stage === 'won') {
        wonDealPoints.push({
          id: makePointId('won', opportunity.id),
          vector,
          payload: dealPayload,
        });
      } else if (opportunity.commercial_stage === 'lost') {
        lostDealPoints.push({
          id: makePointId('lost', opportunity.id),
          vector,
          payload: dealPayload,
        });
      }
    }

    if (opportunity.project_object?.raw_value) {
      const text = buildObjectHistoryText(opportunity);
      const vector = await createEmbedding(text);
      objectHistoryPoints.push({
        id: makePointId('object', opportunity.id),
        vector,
        payload: {
          ...basePayload,
          entity_type: 'object_history',
          title: opportunity.project_object.raw_value,
          text,
        },
      });
    }

    if (opportunity.contact_person?.raw_value) {
      const text = buildContactText(opportunity);
      const vector = await createEmbedding(text);
      contactPoints.push({
        id: makePointId('contact', opportunity.id),
        vector,
        payload: {
          ...basePayload,
          entity_type: 'contact_person',
          title: opportunity.contact_person.raw_value,
          text,
        },
      });
    }

    for (const event of collectCompetitorMentionEvents(opportunity)) {
      const text = buildCompetitorMentionText(opportunity, event);
      const vector = await createEmbedding(text);
      competitorPoints.push({
        id: makePointId('competitor', event.id ?? `${opportunity.id}:${event.datetime ?? Date.now()}`),
        vector,
        payload: {
          ...basePayload,
          entity_type: 'competitor_mention',
          title: event.summary ?? 'Competitor mention',
          text,
        },
      });
    }
  }

  await upsertPoints(COLLECTIONS.deal_events, dealEventPoints);
  await upsertPoints(COLLECTIONS.won_deals, wonDealPoints);
  await upsertPoints(COLLECTIONS.lost_deals, lostDealPoints);
  await upsertPoints(COLLECTIONS.object_history, objectHistoryPoints);
  await upsertPoints(COLLECTIONS.contact_person, contactPoints);
  await upsertPoints(COLLECTIONS.competitor_mentions, competitorPoints);

  return {
    enabled: true,
    opportunities: opportunities.length,
    embedding_model: EMBEDDING_MODEL,
    collections: getQdrantCollections(),
    synced: {
      deal_events: dealEventPoints.length,
      won_deals: wonDealPoints.length,
      lost_deals: lostDealPoints.length,
      object_history: objectHistoryPoints.length,
      contact_person: contactPoints.length,
      competitor_mentions: competitorPoints.length,
    },
  };
}

export async function searchQdrantCollection(collectionName, {
  text,
  limit = 3,
  must = [],
} = {}) {
  const client = getQdrantClient();
  if (!client || !text?.trim()) {
    return [];
  }

  const vector = await createEmbedding(text);
  return client.search(collectionName, {
    vector,
    limit,
    with_payload: true,
    filter: must.length ? { must } : undefined,
  });
}

export async function getQdrantStatus() {
  if (!hasQdrantConfig()) {
    return {
      enabled: false,
      embedding_model: EMBEDDING_MODEL,
      collections: getQdrantCollections(),
    };
  }

  const client = getQdrantClient();
  const collectionsResponse = await client.getCollections();
  const existing = collectionsResponse.collections.map((item) => item.name);

  return {
    enabled: true,
    embedding_model: EMBEDDING_MODEL,
    collections: Object.entries(COLLECTIONS).map(([key, name]) => ({
      key,
      name,
      exists: existing.includes(name),
    })),
  };
}
