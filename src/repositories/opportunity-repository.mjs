import {
  auditLogStore,
  feedbackStore,
  ingestEventStore,
  opportunityStore,
  recommendationStore,
  stateSnapshotStore,
} from '../dss/sample-data.mjs';
import { hasPostgresConfig } from '../db/postgres.mjs';
import { PostgresOpportunityRepository } from './postgres-opportunity-repository.mjs';
import { buildBitrixEntityPatch, normalizeBitrixEvent } from '../services/bitrix-ingest-service.mjs';
import { evaluateOpportunityState } from '../dss/state-engine.mjs';
import { decideNextAction } from '../dss/decision-engine.mjs';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureOpportunity(externalId) {
  const existing = opportunityStore.get(externalId);
  if (existing) {
    return existing;
  }

  const created = {
    id: externalId,
    bitrix_deal_id: externalId,
    company: null,
    contact_person: null,
    project_object: null,
    address: null,
    equipment_type: null,
    time_window: { start_at: null, duration_days: null },
    commercial_scenario: null,
    decision_access_status: null,
    commercial_stage: null,
    payment_readiness: null,
    technical_requirements: [],
    economic_assessment: {
      expected_margin_percent: null,
      own_equipment_available: null,
      subrent_required: null,
    },
    financial_risk: {
      debt_overdue_days: null,
      credit_limit_blocked: false,
      client_blacklisted: false,
    },
    next_step: {
      code: null,
      due_at: null,
      description: null,
    },
    source_scores: null,
    last_touch_at: null,
    strategy_weight: 1,
    sla_hours: 4,
    graph_signals: {
      cross_sell_open: false,
      competitor_present: false,
    },
    communication_events: [],
  };

  opportunityStore.set(externalId, created);
  return created;
}

function currentRecommendationStatus(actionId) {
  const related = feedbackStore
    .filter((item) => item.action_id === actionId)
    .at(-1);

  if (!related) return 'draft';
  if (related.executed) return 'executed';
  if (related.accepted) return 'accepted';
  if (related.rejected) return 'rejected';
  if (related.shown) return 'shown';
  return 'draft';
}

function roundRate(value) {
  return Number(value.toFixed(3));
}

function currentIsoTime() {
  return new Date().toISOString();
}

function findOpportunityByPatch(patch) {
  if (patch.opportunity_external_id && opportunityStore.has(String(patch.opportunity_external_id))) {
    return opportunityStore.get(String(patch.opportunity_external_id));
  }

  const opportunities = Array.from(opportunityStore.values());

  return opportunities.find((opportunity) => {
    if (patch.company_external_id && opportunity.bitrix_company_id === String(patch.company_external_id)) {
      return true;
    }

    if (patch.company?.normalized_value && opportunity.company?.normalized_value === patch.company.normalized_value) {
      return true;
    }

    if (patch.project_object?.normalized_value && opportunity.project_object?.normalized_value === patch.project_object.normalized_value) {
      return true;
    }

    return false;
  }) ?? null;
}

export class InMemoryOpportunityRepository {
  async listOpportunities() {
    return Array.from(opportunityStore.values()).map(clone);
  }

  async getOpportunityById(id) {
    const item = opportunityStore.get(id);
    return item ? clone(item) : null;
  }

  async saveFeedback(actionId, payload) {
    const event = {
      action_id: actionId,
      shown: payload.shown ?? true,
      accepted: payload.accepted ?? false,
      rejected: payload.rejected ?? false,
      rejection_reason: payload.rejection_reason ?? null,
      executed: payload.executed ?? false,
      deal_result: payload.deal_result ?? null,
      effect_after_1_day: payload.effect_after_1_day ?? null,
      effect_after_3_days: payload.effect_after_3_days ?? null,
      effect_after_7_days: payload.effect_after_7_days ?? null,
      effect_after_30_days: payload.effect_after_30_days ?? null,
      result_after_days: payload.result_after_days ?? null,
      recorded_at: new Date().toISOString(),
    };

    feedbackStore.push(event);
    if (recommendationStore.has(actionId)) {
      const recommendation = recommendationStore.get(actionId);
      recommendation.status = currentRecommendationStatus(actionId);
    }
    return clone(event);
  }

  async listFeedback() {
    return feedbackStore.map(clone);
  }

  async saveAuditLog(entry) {
    const log = {
      id: `audit:${auditLogStore.length + 1}`,
      actor_external_id: entry.actor_external_id ?? null,
      actor_name: entry.actor_name ?? null,
      actor_role: entry.actor_role ?? null,
      action_code: entry.action_code,
      resource_type: entry.resource_type,
      resource_id: entry.resource_id ?? null,
      outcome_code: entry.outcome_code ?? 'success',
      details_json: entry.details_json ?? null,
      created_at: currentIsoTime(),
    };

    auditLogStore.unshift(log);
    return clone(log);
  }

  async listAuditLogs(limit = 50) {
    return auditLogStore.slice(0, limit).map(clone);
  }

  async upsertUserContext(user) {
    return clone({
      id: user.external_id,
      external_id: user.external_id,
      full_name: user.full_name,
      role_code: user.role_code,
    });
  }

  async getFeedbackLearningSummary(limit = 10) {
    const feedback = feedbackStore.map(clone);
    const recommendations = Array.from(recommendationStore.values()).map(clone);
    const recommendationsById = new Map(recommendations.map((item) => [item.id, item]));
    const opportunitiesById = new Map(Array.from(opportunityStore.values()).map((item) => [item.id, item]));

    const totalFeedback = feedback.length;
    const accepted = feedback.filter((item) => item.accepted).length;
    const executed = feedback.filter((item) => item.executed).length;
    const rejected = feedback.filter((item) => item.rejected).length;

    const actionStats = new Map();
    const rejectionReasons = new Map();

    for (const item of feedback) {
      const recommendation = recommendationsById.get(item.action_id);
      const actionCode = recommendation?.action_code ?? 'unknown';
      const current = actionStats.get(actionCode) ?? {
        action_code: actionCode,
        total: 0,
        accepted: 0,
        executed: 0,
        rejected: 0,
      };
      current.total += 1;
      if (item.accepted) current.accepted += 1;
      if (item.executed) current.executed += 1;
      if (item.rejected) current.rejected += 1;
      actionStats.set(actionCode, current);

      if (item.rejection_reason) {
        rejectionReasons.set(item.rejection_reason, (rejectionReasons.get(item.rejection_reason) ?? 0) + 1);
      }
    }

    const actionMetrics = Array.from(actionStats.values())
      .map((item) => ({
        ...item,
        accepted_rate: item.total ? roundRate(item.accepted / item.total) : 0,
        executed_rate: item.total ? roundRate(item.executed / item.total) : 0,
        rejected_rate: item.total ? roundRate(item.rejected / item.total) : 0,
      }))
      .sort((left, right) => right.total - left.total)
      .slice(0, limit);

    const recentFeedback = feedback
      .slice()
      .sort((left, right) => new Date(right.recorded_at).getTime() - new Date(left.recorded_at).getTime())
      .slice(0, limit)
      .map((item) => {
        const recommendation = recommendationsById.get(item.action_id);
        const opportunity = recommendation ? opportunitiesById.get(recommendation.opportunity_id) : null;
        let status = 'shown';
        if (item.executed) status = 'executed';
        else if (item.accepted) status = 'accepted';
        else if (item.rejected) status = 'rejected';

        return {
          action_id: item.action_id,
          action_code: recommendation?.action_code ?? null,
          opportunity_id: recommendation?.opportunity_id ?? null,
          company: opportunity?.company?.raw_value ?? null,
          status,
          recorded_at: item.recorded_at,
        };
      });

    return {
      summary: {
        total_feedback: totalFeedback,
        accepted_rate: totalFeedback ? roundRate(accepted / totalFeedback) : 0,
        executed_rate: totalFeedback ? roundRate(executed / totalFeedback) : 0,
        rejected_rate: totalFeedback ? roundRate(rejected / totalFeedback) : 0,
        recommendation_coverage: recommendations.length ? roundRate(totalFeedback / recommendations.length) : 0,
      },
      action_metrics: actionMetrics,
      rejection_reasons: Array.from(rejectionReasons.entries())
        .map(([reason, total]) => ({ reason, total }))
        .sort((left, right) => right.total - left.total)
        .slice(0, limit),
      recent_feedback: recentFeedback,
    };
  }

  async persistStateEvaluation(opportunity, stateEvaluation) {
    stateSnapshotStore.set(opportunity.id, clone(stateEvaluation.states));
    return {
      opportunity_id: opportunity.id,
      persisted: false,
      state_evaluation: clone(stateEvaluation),
    };
  }

  async persistDecisionEvaluation(opportunity, stateEvaluation, decisionEvaluation) {
    const recommendationId = `memory:${opportunity.id}:${decisionEvaluation.recommended_action?.action_code ?? 'none'}`;
    recommendationStore.set(recommendationId, {
      id: recommendationId,
      opportunity_id: opportunity.id,
      action_code: decisionEvaluation.recommended_action?.action_code ?? null,
      target_role: decisionEvaluation.recommended_action?.target_role ?? null,
      deadline_at: decisionEvaluation.deadline_at,
      escalation_action_code: decisionEvaluation.escalation_action?.action_code ?? null,
      explainability_json: clone(decisionEvaluation.explainability),
      status: currentRecommendationStatus(recommendationId),
      created_at: new Date().toISOString(),
    });

    return {
      recommendation_id: recommendationId,
      status: currentRecommendationStatus(recommendationId),
      deadline_at: decisionEvaluation.deadline_at,
      state_evaluation: clone(stateEvaluation),
      decision_evaluation: clone(decisionEvaluation),
    };
  }

  async listStateSnapshots(opportunityId) {
    const snapshots = stateSnapshotStore.get(opportunityId);
    if (!snapshots) {
      return [];
    }
    return snapshots.map((state) => ({
      opportunity_id: opportunityId,
      state_code: state.state_code,
      confidence_score: state.confidence_score,
      reason: state.reason,
      snapshot_time: state.timestamp,
    }));
  }

  async listRecommendations(opportunityId) {
    return Array.from(recommendationStore.values())
      .filter((item) => item.opportunity_id === opportunityId)
      .map(clone)
      .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());
  }

  async listFailedIngestEvents(limit = 100) {
    return ingestEventStore
      .filter((event) => event.processing_status === 'failed')
      .slice(0, limit)
      .map(clone);
  }

  async listNormalizationResults(limit = 500) {
    const items = [];
    for (const opportunity of opportunityStore.values()) {
      for (const [entity_kind, value] of [
        ['company', opportunity.company],
        ['project_object', opportunity.project_object],
        ['address', opportunity.address],
        ['equipment_type', opportunity.equipment_type],
      ]) {
        if (!value) continue;
        items.push({
          entity_kind,
          source_record_type: 'opportunity',
          source_record_id: opportunity.id,
          raw_value: value.raw_value,
          normalized_value: value.normalized_value,
          confidence_score: value.confidence_score,
          resolved_entity_id: value.resolved_entity_id,
        });
      }
    }
    return items.slice(0, limit).map(clone);
  }

  async saveIngestEvent(payload) {
    const normalized = normalizeBitrixEvent(payload);
    const event = {
      id: `ingest-memory-${ingestEventStore.length + 1}`,
      source_system: normalized.source,
      source_event_type: normalized.event_type,
      source_event_id: `${normalized.entity_type}:${normalized.entity_id}`,
      payload: normalized,
      processing_status: 'pending',
      retry_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    ingestEventStore.push(event);
    return clone(event);
  }

  async listPendingIngestEvents(limit = 50) {
    return ingestEventStore
      .filter((event) => event.processing_status === 'pending')
      .slice(0, limit)
      .map(clone);
  }

  async processPendingIngestEvents(limit = 50) {
    const pending = await this.listPendingIngestEvents(limit);
    const processed = [];

    for (const event of pending) {
      const patch = buildBitrixEntityPatch(event.payload);
      if (patch.kind === 'deal') {
        const opportunity = ensureOpportunity(patch.external_id);
        opportunity.bitrix_deal_id = patch.bitrix_deal_id ?? opportunity.bitrix_deal_id;
        opportunity.bitrix_company_id = patch.company_external_id
          ? String(patch.company_external_id)
          : (patch.company?.resolved_entity_id ?? opportunity.bitrix_company_id ?? null);
        opportunity.company = patch.company ?? opportunity.company;
        opportunity.contact_person = patch.person ?? opportunity.contact_person;
        opportunity.project_object = patch.project_object ?? opportunity.project_object;
        opportunity.address = patch.address ?? opportunity.address;
        opportunity.equipment_type = patch.equipment_type ?? opportunity.equipment_type;
        opportunity.time_window = {
          start_at: patch.requested_start_at ?? opportunity.time_window?.start_at ?? null,
          duration_days: patch.requested_duration_days ?? opportunity.time_window?.duration_days ?? null,
        };
        opportunity.commercial_scenario = patch.commercial_scenario ?? opportunity.commercial_scenario;
        opportunity.decision_access_status = patch.decision_access_status ?? opportunity.decision_access_status;
        opportunity.commercial_stage = patch.commercial_stage ?? opportunity.commercial_stage;
        opportunity.payment_readiness = patch.payment_readiness ?? opportunity.payment_readiness;
        opportunity.technical_requirements = patch.technical_requirements ?? opportunity.technical_requirements;
        opportunity.economic_assessment = {
          ...opportunity.economic_assessment,
          expected_margin_percent: patch.expected_margin_percent ?? opportunity.economic_assessment?.expected_margin_percent ?? null,
          own_equipment_available: patch.own_equipment_available ?? opportunity.economic_assessment?.own_equipment_available ?? null,
          subrent_required: patch.subrent_required ?? opportunity.economic_assessment?.subrent_required ?? null,
        };
        opportunity.financial_risk = {
          ...opportunity.financial_risk,
          debt_overdue_days: patch.debt_overdue_days ?? opportunity.financial_risk?.debt_overdue_days ?? null,
          credit_limit_blocked: patch.credit_limit_blocked ?? opportunity.financial_risk?.credit_limit_blocked ?? false,
          client_blacklisted: patch.client_blacklisted ?? opportunity.financial_risk?.client_blacklisted ?? false,
        };
        opportunity.last_touch_at = patch.last_touch_at ?? opportunity.last_touch_at;
        opportunity.next_step = {
          code: patch.next_step_code ?? opportunity.next_step?.code ?? null,
          due_at: patch.next_step_due_at ?? opportunity.next_step?.due_at ?? null,
          description: patch.next_step_description ?? opportunity.next_step?.description ?? null,
        };
        opportunity.source_scores = patch.score_overrides ?? opportunity.source_scores ?? null;
      }

      if (patch.kind === 'communication_event') {
        const matchedOpportunity = findOpportunityByPatch(patch);
        const opportunityExternalId = patch.opportunity_external_id ? String(patch.opportunity_external_id) : null;
        if (matchedOpportunity || opportunityExternalId) {
          const opportunity = matchedOpportunity ?? ensureOpportunity(opportunityExternalId);
          opportunity.communication_events = opportunity.communication_events ?? [];
          opportunity.company = patch.company ?? opportunity.company;
          opportunity.contact_person = patch.person ?? opportunity.contact_person;
          opportunity.project_object = patch.project_object ?? opportunity.project_object;
          opportunity.communication_events.unshift({
            id: patch.external_id,
            type: patch.event_type,
            channel: patch.channel,
            summary: patch.summary_text ?? '',
            text: patch.raw_text ?? '',
            datetime: patch.event_datetime,
          });
          opportunity.last_touch_at = patch.event_datetime ?? opportunity.last_touch_at;
        }
      }

      let recalculated = null;
      if (patch.kind === 'deal' || patch.kind === 'communication_event') {
        const targetOpportunityId = patch.kind === 'deal'
          ? String(patch.external_id)
          : (findOpportunityByPatch(patch)?.id ?? (patch.opportunity_external_id ? String(patch.opportunity_external_id) : null));

        if (targetOpportunityId && opportunityStore.has(targetOpportunityId)) {
          const opportunity = opportunityStore.get(targetOpportunityId);
          const stateEvaluation = evaluateOpportunityState(opportunity);
          const decisionEvaluation = decideNextAction(stateEvaluation);
          recalculated = {
            opportunity_id: targetOpportunityId,
            priority_score: stateEvaluation.priority_score,
            recommended_action: decisionEvaluation.recommended_action?.action_code ?? null,
          };
        }
      }

      event.processing_status = 'processed';
      event.updated_at = new Date().toISOString();
      processed.push({
        ingest_event_id: event.id,
        kind: patch.kind,
        external_id: patch.external_id,
        recalculated,
      });
    }

    return {
      processed_count: processed.length,
      processed,
    };
  }
}

export function createRepository() {
  if (hasPostgresConfig()) {
    return new PostgresOpportunityRepository();
  }

  return new InMemoryOpportunityRepository();
}
