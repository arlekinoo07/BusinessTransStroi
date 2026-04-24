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
      const matchReasons = [];
      if (equipment && (item.equipment_type?.normalized_value === equipment || item.equipment_type?.raw_value === equipment)) {
        score += 2;
        matchReasons.push('same_equipment');
      }
      if (objectType && item.project_object?.normalized_value === objectType) {
        score += 1.5;
        matchReasons.push('same_object');
      }
      if (item.commercial_stage === opportunity.commercial_stage) {
        score += 1;
        matchReasons.push('same_stage');
      }
      if (item.decision_access_status === opportunity.decision_access_status) {
        score += 0.5;
        matchReasons.push('same_access');
      }
      if ((item.communication_events ?? []).length > 0) {
        score += 0.25;
        matchReasons.push('has_history');
      }

      const outcome = item.commercial_stage === 'won'
        ? 'won'
        : item.commercial_stage === 'lost'
          ? 'lost'
          : item.commercial_stage ?? 'qualified';

      const source = matchReasons.includes('same_object')
        ? 'object_history'
        : matchReasons.includes('same_access')
          ? 'contact_person'
          : 'heuristic';

      return {
        title: item.company?.raw_value ?? `Opportunity ${item.id}`,
        outcome,
        hint: item.next_step?.description ?? 'Похожий кейс из локального fallback-поиска.',
        score,
        source,
        recommended_action_hint: item.next_step?.code ?? null,
        match_reasons: matchReasons,
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

  const must = [
    {
      key: 'equipment_type',
      match: { value: opportunity.equipment_type?.normalized_value ?? opportunity.equipment_type?.raw_value ?? '' },
    },
  ].filter((item) => item.match.value);

  const collectionPriority = opportunity.commercial_stage === 'lost'
    ? [collections.lost_deals, collections.object_history, collections.deal_events]
    : [collections.won_deals, collections.object_history, collections.deal_events];

  const results = [];
  for (const collectionName of collectionPriority) {
    const response = await searchQdrantCollection(collectionName, {
      text: searchText,
      limit: 3,
      must,
    });

    for (const item of response) {
      results.push({
        title: item.payload?.title ?? `Deal ${item.payload?.bitrix_id ?? item.id}`,
        outcome: item.payload?.commercial_stage ?? item.payload?.entity_type ?? 'deal',
        hint: item.payload?.text?.slice(0, 180) ?? 'Semantic match from Qdrant.',
        score: Number(item.score?.toFixed?.(3) ?? item.score ?? 0),
        source: item.payload?.entity_type ?? collectionName,
        recommended_action_hint: item.payload?.next_step_code ?? null,
        match_reasons: [
          item.payload?.equipment_type ? 'same_equipment' : null,
          item.payload?.object ? 'same_object' : null,
          item.payload?.decision_access_status ? 'same_access' : null,
        ].filter(Boolean),
      });
    }

    if (results.length >= 3) {
      break;
    }
  }

  return Array.from(
    new Map(results.map((item) => [`${item.title}:${item.source}`, item])).values(),
  ).slice(0, 3);
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
