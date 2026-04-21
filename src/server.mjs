import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

import { getContractsOverview } from './dss/contracts.mjs';
import { adaptBitrixWebhookPayload } from './bitrix-webhook-adapter.mjs';
import { decideNextAction } from './dss/decision-engine.mjs';
import { extractEntitiesFromText } from './dss/nlp-extraction.mjs';
import { findDuplicateCandidates } from './dss/normalization.mjs';
import { requirePermission, resolveAuthContext } from './services/auth-permissions-service.mjs';
import {
  getNeo4jStatus,
  getObjectGraphFromNeo4j,
  getOpportunityGraphFromNeo4j,
} from './services/neo4j-graph-service.mjs';
import { createRepository } from './repositories/opportunity-repository.mjs';
import { getQdrantStatus } from './services/qdrant-vector-service.mjs';
import { getSimilarCases } from './services/similar-cases-service.mjs';
import { evaluateOpportunityState } from './dss/state-engine.mjs';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const repository = createRepository();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload, null, 2));
}

function notFound(response) {
  sendJson(response, 404, { error: 'Not found' });
}

async function writeAuditLog(auth, actionCode, resourceType, resourceId, details = {}, outcomeCode = 'success') {
  await repository.saveAuditLog({
    actor_external_id: auth?.user?.external_id ?? null,
    actor_name: auth?.user?.full_name ?? null,
    actor_role: auth?.user?.role_code ?? null,
    action_code: actionCode,
    resource_type: resourceType,
    resource_id: resourceId ?? null,
    outcome_code: outcomeCode,
    details_json: details,
  });
}

async function serveStaticFile(response, relativePath) {
  const safePath = relativePath.replace(/^\/+/, '') || 'index.html';
  const filePath = path.resolve(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    notFound(response);
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
    });
    response.end(content);
  } catch {
    notFound(response);
  }
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function getOpportunity(id) {
  return repository.getOpportunityById(id);
}

async function evaluateAndPersistState(opportunity) {
  const state = evaluateOpportunityState(opportunity);
  await repository.persistStateEvaluation(opportunity, state);
  return state;
}

async function evaluateAndPersistDecision(opportunity) {
  const state = await evaluateAndPersistState(opportunity);
  const decision = decideNextAction(state);
  const persistedDecision = await repository.persistDecisionEvaluation(opportunity, state, decision);

  return {
    ...decision,
    recommendation_id: persistedDecision.recommendation_id,
    recommendation_status: persistedDecision.status,
  };
}

function toPriorityBucket(priorityScore) {
  if (priorityScore >= 20) return 'critical';
  if (priorityScore >= 10) return 'high';
  if (priorityScore >= 3) return 'medium';
  return 'low';
}

function buildQueueItem(opportunity, state, decision) {
  return {
    opportunity_id: opportunity.id,
    bitrix_deal_id: opportunity.bitrix_deal_id,
    company: opportunity.company?.raw_value ?? null,
    object: opportunity.project_object?.raw_value ?? null,
    priority_score: state.priority_score,
    priority_bucket: toPriorityBucket(state.priority_score),
    next_action: decision.recommended_action?.action_name ?? null,
    next_action_code: decision.recommended_action?.action_code ?? null,
    why_now: decision.explainability.why_important[0] ?? null,
    risk_summary: decision.explainability.risk_if_ignored ?? null,
    deadline_at: decision.deadline_at,
    state_codes: state.states.map((item) => item.state_code),
    score_vector: state.scores,
  };
}

function collectSignalEvidence(opportunity) {
  const events = opportunity.communication_events ?? [];
  const competitorEvents = [];
  const debtRiskEvents = [];
  const subrentEvents = [];
  const promiseEvents = [];
  const noiseEvents = [];

  for (const event of events) {
    const extraction = event.extraction_json ?? {};
    const baseEvidence = {
      event_id: event.id,
      channel: event.channel ?? null,
      datetime: event.datetime ?? null,
      summary: event.summary ?? event.text ?? null,
    };

    if (extraction.is_noise) {
      noiseEvents.push({
        ...baseEvidence,
        reason: extraction.noise_reason ?? null,
        markers: extraction.noise_markers ?? [],
      });
    }

    if (extraction.competitor?.mentioned) {
      competitorEvents.push({
        ...baseEvidence,
        markers: extraction.competitor.markers ?? [],
      });
    }

    if (extraction.debt_risk?.mentioned) {
      debtRiskEvents.push({
        ...baseEvidence,
        markers: extraction.debt_risk.markers ?? [],
        requires_prepayment: extraction.debt_risk.requires_prepayment ?? false,
      });
    }

    if (extraction.supply_mode === 'subrent') {
      subrentEvents.push({
        ...baseEvidence,
        markers: ['subrent'],
      });
    }

    if (extraction.manager_promise?.raw_value || extraction.next_touch_hint) {
      promiseEvents.push({
        ...baseEvidence,
        promise: extraction.manager_promise?.raw_value ?? extraction.next_touch_hint ?? null,
        due_at: extraction.manager_promise?.due_at ?? extraction.next_touch_due_at ?? null,
        action_code: extraction.next_touch_action_code ?? null,
      });
    }
  }

  return {
    flags: {
      competitor_present: opportunity.graph_signals?.competitor_present ?? false,
      debt_risk: (opportunity.financial_risk?.debt_overdue_days ?? 0) > 0 || opportunity.financial_risk?.credit_limit_blocked,
      subrent_required: opportunity.economic_assessment?.subrent_required ?? false,
      manager_promise_overdue: Boolean(
        opportunity.next_step?.due_at && new Date(opportunity.next_step.due_at).getTime() < Date.now(),
      ),
    },
    counters: {
      communication_events: events.length,
      competitor_mentions: competitorEvents.length,
      debt_markers: debtRiskEvents.length,
      subrent_markers: subrentEvents.length,
      promise_markers: promiseEvents.length,
      ignored_noise_events: noiseEvents.length,
    },
    evidence: {
      competitor: competitorEvents.slice(0, 5),
      debt_risk: debtRiskEvents.slice(0, 5),
      subrent: subrentEvents.slice(0, 5),
      manager_promises: promiseEvents.slice(0, 5),
      ignored_noise: noiseEvents.slice(0, 5),
    },
  };
}

export async function buildManagerDashboard() {
  const opportunities = await repository.listOpportunities();
  return opportunities
    .map((opportunity) => {
      const state = evaluateOpportunityState(opportunity);
      const decision = decideNextAction(state);
      return buildQueueItem(opportunity, state, decision);
    })
    .sort((left, right) => right.priority_score - left.priority_score);
}

export async function buildRopDashboard() {
  const opportunities = await repository.listOpportunities();
  return opportunities
    .map((opportunity) => {
      const state = evaluateOpportunityState(opportunity);
      const decision = decideNextAction(state);
      const riskEvidence = collectSignalEvidence(opportunity);
      let escalationType = 'monitor';
      let escalationReason = state.states[0]?.reason ?? 'Требует внимания РОПа.';

      if (state.states.some((item) => item.state_code === 'hot_unworked')) {
        escalationType = 'sla_breach';
        escalationReason = 'Горячая сделка без движения дольше SLA.';
      } else if (state.states.some((item) => item.state_code === 'debt_risk')) {
        escalationType = 'debt_risk';
        escalationReason = 'У клиента риск дебиторки, нужно управленческое решение.';
      } else if ((opportunity.economic_assessment?.expected_margin_percent ?? 0) < 15) {
        escalationType = 'low_margin';
        escalationReason = 'Сделка ниже целевого порога маржи.';
      } else if (state.states.some((item) => item.state_code === 'hot_subrent_only')) {
        escalationType = 'subrent_only';
        escalationReason = 'Сделка живая, но без своей техники.';
      }

      return {
        opportunity_id: opportunity.id,
        bitrix_deal_id: opportunity.bitrix_deal_id,
        company: opportunity.company?.raw_value ?? null,
        object: opportunity.project_object?.raw_value ?? null,
        priority_score: state.priority_score,
        state_codes: state.states.map((item) => item.state_code),
        margin_percent: opportunity.economic_assessment?.expected_margin_percent ?? null,
        debt_overdue_days: opportunity.financial_risk?.debt_overdue_days ?? null,
        escalation_reason: escalationReason,
        escalation_type: escalationType,
        recommended_action: decision.recommended_action?.action_name ?? null,
        recommendation_status: decision.escalation_action?.action_code ? 'needs_approval' : 'monitor',
        deadline_at: decision.deadline_at,
        evidence_summary: {
          competitor_mentions: riskEvidence.counters.competitor_mentions,
          debt_markers: riskEvidence.counters.debt_markers,
          subrent_markers: riskEvidence.counters.subrent_markers,
          promise_markers: riskEvidence.counters.promise_markers,
        },
        evidence_markers: [
          ...riskEvidence.evidence.competitor.flatMap((item) => item.markers ?? []),
          ...riskEvidence.evidence.debt_risk.flatMap((item) => item.markers ?? []),
          ...(riskEvidence.flags.subrent_required ? ['subrent'] : []),
          ...(riskEvidence.flags.manager_promise_overdue ? ['promise_overdue'] : []),
        ].filter(Boolean).slice(0, 8),
      };
    })
    .filter((item) =>
      item.state_codes.includes('hot_unworked')
      || item.state_codes.includes('debt_risk')
      || item.margin_percent < 15,
    );
}

export async function buildRopEscalations({ limit = 20, escalationType = '' } = {}) {
  const items = await buildRopDashboard();
  return items
    .filter((item) => !escalationType || item.escalation_type === escalationType)
    .sort((left, right) => right.priority_score - left.priority_score)
    .slice(0, limit);
}

function toUrgencyBucket(timeScore) {
  if (timeScore >= 4.5) return 'urgent';
  if (timeScore >= 3) return 'near';
  return 'planned';
}

function buildPartnerHint(opportunity, state) {
  const equipment = opportunity.equipment_type?.normalized_value ?? opportunity.equipment_type?.raw_value ?? 'технику';
  if (state.states.some((item) => item.state_code === 'hot_subrent_only')) {
    return `Подобрать субаренду под ${equipment} и проверить плечо мобилизации.`;
  }
  if (opportunity.economic_assessment?.own_equipment_available) {
    return `Сначала резерв своей техники под ${equipment}.`;
  }
  return `Проверить доступность партнеров по ${equipment}.`;
}

function buildDemandClusterHint(opportunity) {
  const objectName = opportunity.project_object?.raw_value ?? null;
  const companyName = opportunity.company?.raw_value ?? null;
  if (objectName) {
    return `Сгруппировать запросы вокруг объекта "${objectName}".`;
  }
  if (companyName) {
    return `Проверить повторный спрос у клиента "${companyName}".`;
  }
  return 'Проверить кластер похожих запросов в этом регионе.';
}

export async function buildLogisticsDashboard({ limit = 20, mode = '' } = {}) {
  const opportunities = await repository.listOpportunities();
  const items = opportunities
    .map((opportunity) => {
      const state = evaluateOpportunityState(opportunity);
      const decision = decideNextAction(state);
      return {
        opportunity_id: opportunity.id,
        bitrix_deal_id: opportunity.bitrix_deal_id,
        company: opportunity.company?.raw_value ?? null,
        object: opportunity.project_object?.raw_value ?? null,
        equipment_type: opportunity.equipment_type?.normalized_value ?? opportunity.equipment_type?.raw_value ?? null,
        priority_score: state.priority_score,
        urgency_bucket: toUrgencyBucket(state.scores.time),
        own_equipment_available: opportunity.economic_assessment?.own_equipment_available ?? null,
        subrent_required: opportunity.economic_assessment?.subrent_required ?? null,
        recommended_action: decision.recommended_action?.action_name ?? null,
        partner_hint: buildPartnerHint(opportunity, state),
        demand_cluster_hint: buildDemandClusterHint(opportunity),
        deadline_at: decision.deadline_at,
        state_codes: state.states.map((item) => item.state_code),
      };
    })
    .filter((item) =>
      item.urgency_bucket === 'urgent'
      || item.subrent_required
      || item.state_codes.includes('hot_subrent_only')
      || item.state_codes.includes('hot_urgent')
    )
    .filter((item) => {
      if (!mode) return true;
      if (mode === 'subrent') return item.subrent_required || item.state_codes.includes('hot_subrent_only');
      if (mode === 'urgent') return item.urgency_bucket === 'urgent';
      if (mode === 'reserve') return item.own_equipment_available === true;
      return true;
    })
    .sort((left, right) => right.priority_score - left.priority_score)
    .slice(0, limit);

  return items;
}

export async function buildOwnerDashboard({ limit = 20, strategy = '' } = {}) {
  const opportunities = await repository.listOpportunities();
  const items = opportunities
    .map((opportunity) => {
      const state = evaluateOpportunityState(opportunity);
      const decision = decideNextAction(state);
      const margin = opportunity.economic_assessment?.expected_margin_percent ?? null;
      const ownEquipment = opportunity.economic_assessment?.own_equipment_available ?? null;
      const subrentRequired = opportunity.economic_assessment?.subrent_required ?? null;
      const debtRisk = state.states.some((item) => item.state_code === 'debt_risk');

      let strategyFlag = 'monitor';
      let ownerSignal = 'Без стратегического отклонения.';

      if (debtRisk) {
        strategyFlag = 'debt_control';
        ownerSignal = 'Сделка требует контроля риска дебиторки.';
      } else if (subrentRequired && !ownEquipment) {
        strategyFlag = 'subrent_dependency';
        ownerSignal = 'Рост оборота идет через субаренду, а не через свой парк.';
      } else if (margin !== null && margin < 15) {
        strategyFlag = 'margin_risk';
        ownerSignal = 'Маржа ниже рабочего порога.';
      } else if (ownEquipment) {
        strategyFlag = 'fleet_priority';
        ownerSignal = 'Есть шанс загрузить свою технику.';
      }

      return {
        opportunity_id: opportunity.id,
        company: opportunity.company?.raw_value ?? null,
        object: opportunity.project_object?.raw_value ?? null,
        priority_score: state.priority_score,
        margin_percent: margin,
        own_equipment_available: ownEquipment,
        subrent_required: subrentRequired,
        debt_risk: debtRisk,
        strategy_flag: strategyFlag,
        owner_signal: ownerSignal,
        recommended_action: decision.recommended_action?.action_name ?? null,
      };
    })
    .filter((item) => {
      if (!strategy) return item.strategy_flag !== 'monitor';
      return item.strategy_flag === strategy;
    })
    .sort((left, right) => right.priority_score - left.priority_score)
    .slice(0, limit);

  return items;
}

export async function buildManagerQueue({ limit = 20, bucket = '', state = '', search = '' } = {}) {
  const normalizedSearch = search.trim().toLowerCase();
  const items = await buildManagerDashboard();
  return items
    .filter((item) => !bucket || item.priority_bucket === bucket)
    .filter((item) => !state || item.state_codes.includes(state))
    .filter((item) => {
      if (!normalizedSearch) return true;
      return [item.company, item.object, item.next_action, item.why_now]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(normalizedSearch));
    })
    .slice(0, limit);
}

export async function buildOpportunityCard(opportunityId) {
  const opportunity = await repository.getOpportunityById(opportunityId);
  if (!opportunity) {
    return null;
  }

  const state = await evaluateAndPersistState(opportunity);
  const decision = await evaluateAndPersistDecision(opportunity);
  const stateHistory = await repository.listStateSnapshots(opportunityId);
  const recommendationsHistory = await repository.listRecommendations(opportunityId);
  const graph = buildOpportunityGraph(opportunity);
  const similarCases = await getSimilarCases(opportunity, repository);
  const riskEvidence = collectSignalEvidence(opportunity);

  return {
    opportunity_id: opportunity.id,
    bitrix_deal_id: opportunity.bitrix_deal_id,
    summary: {
      company: opportunity.company?.raw_value ?? null,
      contact: opportunity.contact_person?.raw_value ?? null,
      owner_manager: opportunity.owner_manager?.full_name ?? null,
      object: opportunity.project_object?.raw_value ?? null,
      equipment_type: opportunity.equipment_type?.normalized_value ?? opportunity.equipment_type?.raw_value ?? null,
      commercial_stage: opportunity.commercial_stage ?? null,
      last_touch_at: opportunity.last_touch_at ?? null,
    },
    opportunity_unit: opportunity,
    score_vector: state.scores,
    priority_score: state.priority_score,
    states: state.states,
    recommendation: {
      recommendation_id: decision.recommendation_id ?? null,
      recommendation_status: decision.recommendation_status ?? null,
      action_code: decision.recommended_action?.action_code ?? null,
      action_name: decision.recommended_action?.action_name ?? null,
      target_role: decision.recommended_action?.target_role ?? null,
      deadline_at: decision.deadline_at,
      escalation_action_code: decision.escalation_action?.action_code ?? null,
      explainability: decision.explainability,
    },
    communication_history: (opportunity.communication_events ?? []).slice(0, 12),
    risk_evidence: riskEvidence,
    similar_cases: similarCases,
    recommendations_history: recommendationsHistory,
    state_history: stateHistory,
    graph,
  };
}

export function buildOpportunityGraph(opportunity) {
  const nodes = [];
  const edges = [];

  const opportunityNodeId = `opportunity:${opportunity.id}`;
  nodes.push({
    id: opportunityNodeId,
    label: `Opportunity ${opportunity.bitrix_deal_id ?? opportunity.id}`,
    type: 'Opportunity',
  });

  if (opportunity.company?.raw_value) {
    const companyId = opportunity.company.resolved_entity_id ?? `company:${opportunity.company.normalized_value ?? opportunity.company.raw_value}`;
    nodes.push({
      id: companyId,
      label: opportunity.company.raw_value,
      type: 'Company',
    });
    edges.push({ source: opportunityNodeId, target: companyId, type: 'FOR_COMPANY' });
  }

  if (opportunity.contact_person?.raw_value) {
    const personId = opportunity.contact_person.resolved_entity_id ?? `person:${opportunity.contact_person.normalized_value ?? opportunity.contact_person.raw_value}`;
    nodes.push({
      id: personId,
      label: opportunity.contact_person.raw_value,
      type: 'Person',
    });
    edges.push({ source: opportunityNodeId, target: personId, type: 'ASSIGNED_TO' });
    if (opportunity.company?.raw_value) {
      const companyId = opportunity.company.resolved_entity_id ?? `company:${opportunity.company.normalized_value ?? opportunity.company.raw_value}`;
      edges.push({ source: personId, target: companyId, type: 'WORKS_FOR' });
    }
  }

  if (opportunity.project_object?.raw_value) {
    const objectId = opportunity.project_object.resolved_entity_id ?? `object:${opportunity.project_object.normalized_value ?? opportunity.project_object.raw_value}`;
    nodes.push({
      id: objectId,
      label: opportunity.project_object.raw_value,
      type: 'ProjectObject',
    });
    edges.push({ source: opportunityNodeId, target: objectId, type: 'FOR_OBJECT' });
  }

  if (opportunity.equipment_type?.normalized_value || opportunity.equipment_type?.raw_value) {
    const equipmentLabel = opportunity.equipment_type.normalized_value ?? opportunity.equipment_type.raw_value;
    const equipmentId = opportunity.equipment_type.resolved_entity_id ?? `equipment:${equipmentLabel.toLowerCase()}`;
    nodes.push({
      id: equipmentId,
      label: equipmentLabel,
      type: 'EquipmentType',
    });
    edges.push({ source: opportunityNodeId, target: equipmentId, type: 'NEEDS' });
    if (opportunity.project_object?.raw_value) {
      const objectId = opportunity.project_object.resolved_entity_id ?? `object:${opportunity.project_object.normalized_value ?? opportunity.project_object.raw_value}`;
      edges.push({ source: objectId, target: equipmentId, type: 'USES' });
    }
  }

  if (opportunity.graph_signals?.competitor_present) {
    const competitorId = `competitor:${opportunity.id}`;
    nodes.push({
      id: competitorId,
      label: 'Конкурент на объекте',
      type: 'Competitor',
    });
    if (opportunity.project_object?.raw_value) {
      const objectId = opportunity.project_object.resolved_entity_id ?? `object:${opportunity.project_object.normalized_value ?? opportunity.project_object.raw_value}`;
      edges.push({ source: objectId, target: competitorId, type: 'HAS_COMPETITOR' });
    }
  }

  if (opportunity.graph_signals?.cross_sell_open) {
    const crossSellId = `cross-sell:${opportunity.id}`;
    nodes.push({
      id: crossSellId,
      label: 'Кросс-продажа',
      type: 'Scenario',
    });
    edges.push({ source: opportunityNodeId, target: crossSellId, type: 'CROSS_SELL_OPEN' });
  }

  for (const event of (opportunity.communication_events ?? []).slice(0, 3)) {
    const eventId = `event:${event.id}`;
    nodes.push({
      id: eventId,
      label: event.summary || event.type,
      type: 'CommunicationEvent',
    });
    edges.push({ source: opportunityNodeId, target: eventId, type: 'HAS_EVENT' });
  }

  const dedupedNodes = Array.from(new Map(nodes.map((node) => [node.id, node])).values());
  const dedupedEdges = Array.from(new Map(edges.map((edge) => [`${edge.source}:${edge.target}:${edge.type}`, edge])).values());

  return {
    opportunity_id: opportunity.id,
    object_id: opportunity.project_object?.resolved_entity_id ?? null,
    nodes: dedupedNodes,
    edges: dedupedEdges,
  };
}

function buildQualityIssues(opportunity) {
  const issues = [];
  if (!opportunity.company?.normalized_value) issues.push('company_not_normalized');
  if (!opportunity.project_object?.normalized_value) issues.push('object_not_normalized');
  if (!opportunity.equipment_type?.normalized_value) issues.push('equipment_missing');
  if (!opportunity.time_window?.start_at) issues.push('start_date_missing');
  if (!opportunity.time_window?.duration_days) issues.push('duration_missing');
  if (!opportunity.owner_manager?.external_id) issues.push('owner_manager_missing');
  if (!opportunity.next_step?.code && !opportunity.next_step?.description) issues.push('next_step_missing');
  if (!opportunity.last_touch_at) issues.push('last_touch_missing');
  if (!(opportunity.communication_events ?? []).length) issues.push('no_linked_events');
  if (!(opportunity.communication_events ?? []).some((item) => item.channel)) issues.push('channel_missing');
  return issues;
}

export async function buildDataQualityDashboard() {
  const [opportunities, failedIngest, normalizationResults] = await Promise.all([
    repository.listOpportunities(),
    repository.listFailedIngestEvents(200),
    repository.listNormalizationResults(1000),
  ]);

  const totalOpportunities = opportunities.length || 1;
  const linkedEventsCount = opportunities.filter((item) => (item.communication_events ?? []).length > 0).length;
  const normalizedObjectsCount = opportunities.filter((item) => item.project_object?.normalized_value).length;
  const withoutNextStep = opportunities.filter((item) => !item.next_step?.code && !item.next_step?.description).length;
  const missingEquipment = opportunities.filter((item) => !item.equipment_type?.normalized_value).length;
  const coverageMetrics = [
    {
      field_code: 'client',
      label: 'Клиент',
      filled_count: opportunities.filter((item) => item.company?.normalized_value).length,
      target_percent: 90,
    },
    {
      field_code: 'object',
      label: 'Объект',
      filled_count: opportunities.filter((item) => item.project_object?.normalized_value).length,
      target_percent: 85,
    },
    {
      field_code: 'equipment_type',
      label: 'Тип техники',
      filled_count: opportunities.filter((item) => item.equipment_type?.normalized_value).length,
      target_percent: 90,
    },
    {
      field_code: 'requested_start_at',
      label: 'Предполагаемая дата',
      filled_count: opportunities.filter((item) => item.time_window?.start_at).length,
      target_percent: 90,
    },
    {
      field_code: 'duration_days',
      label: 'Длительность',
      filled_count: opportunities.filter((item) => item.time_window?.duration_days).length,
      target_percent: 90,
    },
    {
      field_code: 'channel',
      label: 'Канал связи',
      filled_count: opportunities.filter((item) => (item.communication_events ?? []).some((event) => event.channel)).length,
      target_percent: 90,
    },
    {
      field_code: 'last_touch_at',
      label: 'Последнее касание',
      filled_count: opportunities.filter((item) => item.last_touch_at).length,
      target_percent: 90,
    },
    {
      field_code: 'owner_manager',
      label: 'Ответственный',
      filled_count: opportunities.filter((item) => item.owner_manager?.external_id).length,
      target_percent: 95,
    },
    {
      field_code: 'next_step',
      label: 'Следующий шаг',
      filled_count: opportunities.filter((item) => item.next_step?.code || item.next_step?.description).length,
      target_percent: 95,
    },
  ].map((item) => {
    const filledPercent = Math.round((item.filled_count / totalOpportunities) * 100);
    return {
      ...item,
      filled_percent: filledPercent,
      status: filledPercent >= item.target_percent ? 'ok' : filledPercent >= Math.max(50, item.target_percent - 20) ? 'warning' : 'critical',
    };
  });

  const items = opportunities
    .map((opportunity) => {
      const issues = buildQualityIssues(opportunity);
      return {
        opportunity_id: opportunity.id,
        company: opportunity.company?.raw_value ?? null,
        object: opportunity.project_object?.raw_value ?? null,
        quality_score: Math.max(0, 100 - (issues.length * 18)),
        issues,
      };
    })
    .filter((item) => item.issues.length > 0)
    .sort((left, right) => left.quality_score - right.quality_score);

  return {
    summary: {
      total_opportunities: opportunities.length,
      linked_events_percent: Math.round((linkedEventsCount / totalOpportunities) * 100),
      normalized_objects_percent: Math.round((normalizedObjectsCount / totalOpportunities) * 100),
      opportunities_without_next_step: withoutNextStep,
      opportunities_missing_equipment: missingEquipment,
      failed_ingest_events: failedIngest.length,
      normalization_records: normalizationResults.length,
      critical_fields: coverageMetrics,
    },
    items,
  };
}

export async function buildNormalizationDashboard() {
  const opportunities = await repository.listOpportunities();

  const companies = opportunities
    .filter((item) => item.company?.raw_value)
    .map((item) => ({
      opportunity_id: item.id,
      ...item.company,
    }));

  const objects = opportunities
    .filter((item) => item.project_object?.raw_value)
    .map((item) => ({
      opportunity_id: item.id,
      ...item.project_object,
    }));

  const persons = opportunities
    .filter((item) => item.contact_person?.raw_value)
    .map((item) => ({
      opportunity_id: item.id,
      raw_value: item.contact_person.raw_value,
      normalized_value: item.contact_person.normalized_value,
      resolved_entity_id: item.contact_person.resolved_entity_id,
      confidence_score: item.contact_person.confidence_score,
    }));

  const candidates = [
    ...findDuplicateCandidates(companies, {
      kind: 'company',
      getReferenceId: (item) => `${item.opportunity_id}:${item.resolved_entity_id ?? item.raw_value}`,
    }),
    ...findDuplicateCandidates(objects, {
      kind: 'object',
      getReferenceId: (item) => `${item.opportunity_id}:${item.resolved_entity_id ?? item.raw_value}`,
    }),
    ...findDuplicateCandidates(persons, {
      kind: 'person',
      threshold: 0.82,
      getReferenceId: (item) => `${item.opportunity_id}:${item.resolved_entity_id ?? item.raw_value}`,
    }),
  ]
    .sort((left, right) => right.similarity_score - left.similarity_score)
    .slice(0, 50);

  return {
    summary: {
      companies_seen: companies.length,
      objects_seen: objects.length,
      persons_seen: persons.length,
      duplicate_candidates: candidates.length,
    },
    items: candidates,
  };
}

export async function buildFeedbackLearningDashboard() {
  return repository.getFeedbackLearningSummary(12);
}

export async function buildAuditDashboard(limit = 20) {
  return {
    items: await repository.listAuditLogs(limit),
  };
}

export function createAppServer() {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const auth = resolveAuthContext(request);

      if (request.method === 'GET' && url.pathname === '/health') {
        return sendJson(response, 200, { status: 'ok', service: 'ai-sales-decision-engine' });
      }

      if (request.method === 'GET' && url.pathname === '/auth/me') {
        await repository.upsertUserContext(auth.user);
        return sendJson(response, 200, auth);
      }

      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/app')) {
        await serveStaticFile(response, 'index.html');
        return;
      }

      if (request.method === 'GET' && url.pathname.startsWith('/app/')) {
        await serveStaticFile(response, url.pathname.replace('/app/', ''));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/events/bitrix') {
        const denied = requirePermission(auth, 'dashboard.data_quality');
        if (denied) return sendJson(response, 403, denied);
        const payload = await readJson(request);
        const normalizedPayload = payload?.event ? adaptBitrixWebhookPayload(payload) : payload;
        const acceptedEvent = await repository.saveIngestEvent(normalizedPayload);
        await writeAuditLog(auth, 'bitrix_event_accept', 'ingest_event', acceptedEvent.id, {
          source_event_id: acceptedEvent.source_event_id ?? null,
        });
        return sendJson(response, 202, {
          accepted: true,
          message: 'Событие принято в ingest-контур.',
          ingest_event: acceptedEvent,
        });
      }

      if (request.method === 'GET' && url.pathname === '/events/bitrix/pending') {
        const denied = requirePermission(auth, 'dashboard.data_quality');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, {
          items: await repository.listPendingIngestEvents(100),
        });
      }

      if (request.method === 'GET' && url.pathname === '/events/bitrix/errors') {
        const denied = requirePermission(auth, 'dashboard.data_quality');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, {
          items: await repository.listFailedIngestEvents(100),
        });
      }

      if (request.method === 'POST' && url.pathname === '/events/bitrix/process') {
        const denied = requirePermission(auth, 'dashboard.data_quality');
        if (denied) return sendJson(response, 403, denied);
        const payload = await readJson(request);
        const limit = Number(payload.limit ?? 50);
        const result = await repository.processPendingIngestEvents(limit);
        await writeAuditLog(auth, 'ingest_process', 'ingest_batch', null, {
          limit,
          processed_count: result.processed_count,
        });
        return sendJson(response, 200, result);
      }

      if (request.method === 'POST' && url.pathname === '/nlp/extract') {
        const payload = await readJson(request);
        return sendJson(response, 200, {
          text: payload.text ?? '',
          extraction: extractEntitiesFromText(payload.text ?? ''),
        });
      }

      if (request.method === 'GET' && url.pathname === '/meta/contracts') {
        return sendJson(response, 200, getContractsOverview());
      }

      if (request.method === 'GET' && url.pathname === '/vectors/status') {
        return sendJson(response, 200, await getQdrantStatus());
      }

      if (request.method === 'GET' && url.pathname === '/graph/status') {
        return sendJson(response, 200, await getNeo4jStatus());
      }

      if (request.method === 'GET' && url.pathname.startsWith('/opportunities/')) {
        const [, resource, id, action] = url.pathname.split('/');
        if (resource !== 'opportunities' || !id) {
          return notFound(response);
        }

        const opportunity = await getOpportunity(id);
        if (!opportunity) {
          return sendJson(response, 404, { error: 'Opportunity not found', id });
        }

        if (action === 'state') {
          const denied = requirePermission(auth, 'opportunity.view');
          if (denied) return sendJson(response, 403, denied);
          return sendJson(response, 200, await evaluateAndPersistState(opportunity));
        }

        if (action === 'state-history') {
          return sendJson(response, 200, {
            opportunity_id: id,
            items: await repository.listStateSnapshots(id),
          });
        }

        if (action === 'decision') {
          const denied = requirePermission(auth, 'opportunity.decision');
          if (denied) return sendJson(response, 403, denied);
          const result = await evaluateAndPersistDecision(opportunity);
          await writeAuditLog(auth, 'view_decision', 'opportunity', id, {
            recommendation_id: result.recommendation_id ?? null,
          });
          return sendJson(response, 200, result);
        }

        if (action === 'card') {
          const denied = requirePermission(auth, 'opportunity.view');
          if (denied) return sendJson(response, 403, denied);
          return sendJson(response, 200, await buildOpportunityCard(id));
        }

        if (action === 'graph') {
          const denied = requirePermission(auth, 'opportunity.graph');
          if (denied) return sendJson(response, 403, denied);
          const neo4jGraph = await getOpportunityGraphFromNeo4j(id);
          return sendJson(response, 200, neo4jGraph ?? buildOpportunityGraph(opportunity));
        }

        if (action === 'similar-cases') {
          return sendJson(response, 200, {
            opportunity_id: id,
            items: await getSimilarCases(opportunity, repository),
          });
        }

        if (action === 'recommendations') {
          return sendJson(response, 200, {
            opportunity_id: id,
            items: await repository.listRecommendations(id),
          });
        }

        return sendJson(response, 200, opportunity);
      }

      if (request.method === 'GET' && url.pathname === '/dashboard/manager') {
        const denied = requirePermission(auth, 'dashboard.manager');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, { items: await buildManagerDashboard() });
      }

      if (request.method === 'GET' && url.pathname === '/dashboard/manager/queue') {
        const denied = requirePermission(auth, 'dashboard.manager');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, {
          items: await buildManagerQueue({
            limit: Number(url.searchParams.get('limit') ?? 20),
            bucket: url.searchParams.get('bucket') ?? '',
            state: url.searchParams.get('state') ?? '',
            search: url.searchParams.get('search') ?? '',
          }),
        });
      }

      if (request.method === 'GET' && url.pathname === '/dashboard/rop') {
        const denied = requirePermission(auth, 'dashboard.rop');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, { items: await buildRopDashboard() });
      }

      if (request.method === 'GET' && url.pathname === '/dashboard/rop/escalations') {
        const denied = requirePermission(auth, 'dashboard.rop');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, {
          items: await buildRopEscalations({
            limit: Number(url.searchParams.get('limit') ?? 20),
            escalationType: url.searchParams.get('type') ?? '',
          }),
        });
      }

      if (request.method === 'GET' && url.pathname === '/dashboard/logistics') {
        const denied = requirePermission(auth, 'dashboard.logistics');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, {
          items: await buildLogisticsDashboard({
            limit: Number(url.searchParams.get('limit') ?? 20),
            mode: url.searchParams.get('mode') ?? '',
          }),
        });
      }

      if (request.method === 'GET' && url.pathname === '/dashboard/owner') {
        const denied = requirePermission(auth, 'dashboard.owner');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, {
          items: await buildOwnerDashboard({
            limit: Number(url.searchParams.get('limit') ?? 20),
            strategy: url.searchParams.get('strategy') ?? '',
          }),
        });
      }

      if (request.method === 'GET' && url.pathname === '/dashboard/data-quality') {
        const denied = requirePermission(auth, 'dashboard.data_quality');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, await buildDataQualityDashboard());
      }

      if (request.method === 'GET' && url.pathname === '/dashboard/normalization') {
        const denied = requirePermission(auth, 'dashboard.normalization');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, await buildNormalizationDashboard());
      }

      if (request.method === 'GET' && url.pathname === '/dashboard/feedback-learning') {
        const denied = requirePermission(auth, 'dashboard.feedback_learning');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, await buildFeedbackLearningDashboard());
      }

      if (request.method === 'GET' && url.pathname === '/audit/logs') {
        const denied = requirePermission(auth, 'audit.view');
        if (denied) return sendJson(response, 403, denied);
        return sendJson(response, 200, await buildAuditDashboard(Number(url.searchParams.get('limit') ?? 20)));
      }

      if (request.method === 'GET' && url.pathname.startsWith('/objects/')) {
        const [, resource, id, graphPart] = url.pathname.split('/');
        if (resource !== 'objects' || graphPart !== 'graph') {
          return notFound(response);
        }

        const opportunities = await repository.listOpportunities();
        const matched = opportunities.find((item) =>
          item.project_object?.resolved_entity_id === id
          || item.project_object?.normalized_value === id
          || item.project_object?.raw_value === id,
        );

        const neo4jGraph = await getObjectGraphFromNeo4j(id);
        return sendJson(response, 200, neo4jGraph ?? (matched ? buildOpportunityGraph(matched) : {
          object_id: id,
          nodes: [],
          edges: [],
        }));
      }

      if (request.method === 'POST' && url.pathname.startsWith('/actions/')) {
        const [, resource, id, feedbackPart] = url.pathname.split('/');
        if (resource !== 'actions' || feedbackPart !== 'feedback') {
          return notFound(response);
        }
        const denied = requirePermission(auth, 'feedback.write');
        if (denied) return sendJson(response, 403, denied);

        const payload = await readJson(request);
        const result = await repository.saveFeedback(id, payload);
        await writeAuditLog(auth, 'recommendation_feedback', 'recommendation', id, {
          accepted: payload.accepted ?? false,
          rejected: payload.rejected ?? false,
          executed: payload.executed ?? false,
        });
        return sendJson(response, 201, result);
      }

      return notFound(response);
    } catch (error) {
      return sendJson(response, 500, {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export function startServer() {
  const server = createAppServer();
  server.listen(PORT, HOST, () => {
    console.log(`AI Sales Decision Engine API listening on http://${HOST}:${PORT}`);
  });

  return server;
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  startServer();
}
