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
  const managerQueue = await buildManagerQueue({ limit: 5 });
  const managerAttackNow = await buildManagerQueue({ limit: 5, mode: 'attack_now' });
  const managerVerify = await buildManagerQueue({ limit: 5, mode: 'verify' });
  const managerOverdue = await buildManagerQueue({ limit: 5, mode: 'overdue' });
  const managerBlocked = await buildManagerQueue({ limit: 5, mode: 'blocked' });
  const managerLowPriority = await buildManagerQueue({ limit: 5, mode: 'low_priority' });
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
    top_rop_item: ropDashboard[0] ?? null,
    top_manager_item: managerDashboard[0],
    top_manager_priority_reasons: managerDashboard[0]?.priority_reasons ?? [],
    top_manager_target_role: managerDashboard[0]?.target_role ?? null,
    top_manager_owner: managerDashboard[0]?.recommended_owner ?? null,
    top_manager_promise_overdue: managerDashboard[0]?.promise_overdue ?? false,
    top_manager_sla_breached: managerDashboard[0]?.sla_breached ?? false,
    top_manager_loss_risk: managerDashboard[0]?.loss_risk_level ?? null,
    top_manager_alternative: managerDashboard[0]?.alternative_action ?? null,
    target_opportunity_id: targetOpportunityId,
    manager_queue_items: managerQueue.length,
    manager_attack_now_items: managerAttackNow.length,
    manager_verify_items: managerVerify.length,
    manager_overdue_items: managerOverdue.length,
    manager_blocked_items: managerBlocked.length,
    manager_low_priority_items: managerLowPriority.length,
    rop_escalation_items: ropEscalations.length,
    top_rop_owner: ropDashboard[0]?.recommended_owner ?? null,
    top_rop_target_role: ropDashboard[0]?.target_role ?? null,
    top_rop_promise_overdue: ropDashboard[0]?.promise_overdue ?? false,
    top_rop_sla_breached: ropDashboard[0]?.sla_breached ?? false,
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
    card_similar_cases_vector_live: opportunityCard?.similar_cases_summary?.vector_live ?? false,
    card_top_similar_case_source: opportunityCard?.similar_cases?.[0]?.source ?? null,
    card_top_similar_case_reasons: opportunityCard?.similar_cases?.[0]?.match_reasons ?? [],
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
