import {
  buildAuditDashboard,
  buildDataQualityDashboard,
  buildFeedbackLearningDashboard,
  buildLogisticsDashboard,
  buildManagerDashboard,
  buildManagerQueue,
  buildNormalizationDashboard,
  buildOpportunityCard,
  buildOwnerDashboard,
  buildRopDashboard,
  buildRopEscalations,
} from './server.mjs';
import { getContractsOverview } from './dss/contracts.mjs';
import { getNeo4jStatus } from './services/neo4j-graph-service.mjs';
import { createRepository } from './repositories/opportunity-repository.mjs';

const repository = createRepository();

async function main() {
  const managerDashboard = await buildManagerDashboard();
  const managerQueue = await buildManagerQueue(5);
  const ropDashboard = await buildRopDashboard();
  const ropEscalations = await buildRopEscalations({ limit: 10 });
  const logisticsDashboard = await buildLogisticsDashboard({ limit: 10 });
  const ownerDashboard = await buildOwnerDashboard({ limit: 10 });
  const dataQuality = await buildDataQualityDashboard();
  const normalizationDashboard = await buildNormalizationDashboard();
  const feedbackLearningDashboard = await buildFeedbackLearningDashboard();
  const auditDashboard = await buildAuditDashboard(10);
  const graphStatus = await getNeo4jStatus();
  const targetOpportunityId = managerDashboard[0]?.opportunity_id ?? 'opp-1001';
  const opportunityCard = await buildOpportunityCard(targetOpportunityId);
  if (opportunityCard?.recommendation?.recommendation_id) {
    await repository.saveFeedback(opportunityCard.recommendation.recommendation_id, {
      shown: true,
      accepted: true,
      rejected: false,
      executed: false,
    });
  }
  const refreshedCard = await buildOpportunityCard(targetOpportunityId);
  const stateHistory = await repository.listStateSnapshots(targetOpportunityId);
  const recommendations = await repository.listRecommendations(targetOpportunityId);
  const ingestErrors = await repository.listFailedIngestEvents(10);

  console.log(JSON.stringify({
    manager_items: managerDashboard.length,
    rop_items: ropDashboard.length,
    top_manager_item: managerDashboard[0],
    top_manager_loss_risk: managerDashboard[0]?.loss_risk_level ?? null,
    top_manager_alternative: managerDashboard[0]?.alternative_action ?? null,
    target_opportunity_id: targetOpportunityId,
    manager_queue_items: managerQueue.length,
    rop_escalation_items: ropEscalations.length,
    logistics_items: logisticsDashboard.length,
    owner_items: ownerDashboard.items?.length ?? 0,
    owner_summary: ownerDashboard.summary ?? null,
    data_quality_items: dataQuality.items.length,
    normalization_candidates: normalizationDashboard.items.length,
    feedback_learning_total: feedbackLearningDashboard.summary.total_feedback,
    audit_items: auditDashboard.items.length,
    graph_status_enabled: graphStatus.enabled,
    card_has_recommendation: Boolean(opportunityCard?.recommendation?.action_code),
    card_graph_nodes: opportunityCard?.graph?.nodes?.length ?? 0,
    card_communication_history: opportunityCard?.communication_history?.length ?? 0,
    card_risk_evidence_flags: Object.values(opportunityCard?.risk_evidence?.flags ?? {}).filter(Boolean).length,
    card_stop_signal_count:
      (opportunityCard?.stop_signals?.blocked_reasons?.length ?? 0)
      + (opportunityCard?.stop_signals?.low_priority_reasons?.length ?? 0)
      + (opportunityCard?.stop_signals?.strategy_warnings?.length ?? 0)
      + (opportunityCard?.stop_signals?.wait_conditions?.length ?? 0),
    card_similar_cases: opportunityCard?.similar_cases?.length ?? 0,
    refreshed_recommendation_status: refreshedCard?.recommendation?.recommendation_status ?? null,
    contract_names: Object.keys(getContractsOverview()),
    state_history_items: stateHistory.length,
    recommendation_items: recommendations.length,
    ingest_error_items: ingestErrors.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
