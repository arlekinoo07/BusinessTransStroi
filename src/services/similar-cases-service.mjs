import {
  getQdrantCollections,
  hasQdrantConfig,
  searchQdrantCollection,
} from './qdrant-vector-service.mjs';

function heuristicSimilarCases(opportunity, opportunities) {
  const currentId = opportunity.id;
  const equipment = opportunity.equipment_type?.normalized_value ?? opportunity.equipment_type?.raw_value;
  const objectType = opportunity.project_object?.normalized_value;

  return opportunities
    .filter((item) => item.id !== currentId)
    .map((item) => {
      let score = 0.25;
      if (equipment && (item.equipment_type?.normalized_value === equipment || item.equipment_type?.raw_value === equipment)) {
        score += 2;
      }
      if (objectType && item.project_object?.normalized_value === objectType) {
        score += 1.5;
      }
      if (item.commercial_stage === opportunity.commercial_stage) {
        score += 1;
      }
      if (item.decision_access_status === opportunity.decision_access_status) {
        score += 0.5;
      }
      if ((item.communication_events ?? []).length > 0) {
        score += 0.25;
      }

      return {
        title: item.company?.raw_value ?? `Opportunity ${item.id}`,
        outcome: item.commercial_stage ?? 'qualified',
        hint: item.next_step?.description ?? 'Похожий кейс из локального fallback-поиска.',
        score,
        source: 'heuristic',
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);
}

async function qdrantSimilarCases(opportunity) {
  const collections = getQdrantCollections();
  const searchText = [
    opportunity.company?.raw_value,
    opportunity.project_object?.raw_value,
    opportunity.equipment_type?.normalized_value ?? opportunity.equipment_type?.raw_value,
    opportunity.commercial_stage,
    opportunity.next_step?.description,
    ...(opportunity.communication_events ?? []).slice(0, 3).map((item) => item.summary ?? item.text),
  ].filter(Boolean).join('\n');

  const targetCollection = opportunity.commercial_stage === 'lost'
    ? collections.lost_deals
    : collections.won_deals;

  const response = await searchQdrantCollection(targetCollection, {
    text: searchText,
    limit: 3,
    must: [
      {
        key: 'equipment_type',
        match: { value: opportunity.equipment_type?.normalized_value ?? opportunity.equipment_type?.raw_value ?? '' },
      },
    ].filter((item) => item.match.value),
  });

  return response.map((item) => ({
    title: item.payload?.title ?? `Deal ${item.payload?.bitrix_id ?? item.id}`,
    outcome: item.payload?.commercial_stage ?? 'deal',
    hint: item.payload?.text?.slice(0, 180) ?? 'Semantic match from Qdrant.',
    score: Number(item.score?.toFixed?.(3) ?? item.score ?? 0),
    source: 'qdrant',
  }));
}

export async function getSimilarCases(opportunity, repository) {
  try {
    if (hasQdrantConfig()) {
      const cases = await qdrantSimilarCases(opportunity);
      if (cases.length) {
        return cases;
      }
    }
  } catch {
    // Fall back to heuristic mode when Qdrant or embeddings are unavailable.
  }

  const opportunities = await repository.listOpportunities();
  return heuristicSimilarCases(opportunity, opportunities);
}
