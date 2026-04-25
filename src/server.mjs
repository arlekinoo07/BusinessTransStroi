import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

import { getContractsOverview } from './dss/contracts.mjs';
import { adaptBitrixWebhookPayload } from './bitrix-webhook-adapter.mjs';
import { decideNextAction } from './dss/decision-engine.mjs';
import { extractEntitiesFromText } from './dss/nlp-extraction.mjs';
import { findContextualDuplicateCandidates, findDuplicateCandidates } from './dss/normalization.mjs';
import { buildBitrixEntityPatch } from './services/bitrix-ingest-service.mjs';
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

async function evaluateAndPersistDecision(opportunity, actionEffectiveness = null) {
  const state = await evaluateAndPersistState(opportunity);
  const effectivenessMap = actionEffectiveness ?? await getActionEffectivenessMap();
  const decision = decideNextAction(state, { action_effectiveness: effectivenessMap });
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

function buildLossRiskSummary(opportunity, state) {
  if (state.states.some((item) => item.state_code === 'hot_unworked')) {
    return {
      level: 'high',
      reason: 'Сделка горячая, но зависла без реакции в рабочем SLA.',
    };
  }
  if (state.states.some((item) => item.state_code === 'hot_urgent')) {
    return {
      level: 'high',
      reason: 'Окно мобилизации близко, клиент может уйти к конкуренту быстрее обычного.',
    };
  }
  if (state.states.some((item) => item.state_code === 'hot_subrent_only')) {
    return {
      level: 'medium',
      reason: 'Реальный спрос есть, но без решения по субаренде сделка быстро уходит.',
    };
  }
  if (state.states.some((item) => item.state_code === 'debt_risk')) {
    return {
      level: 'medium',
      reason: 'Есть риск потерять не сделку, а экономику сделки из-за условий оплаты.',
    };
  }
  if (state.states.some((item) => item.state_code === 'noise_low_priority')) {
    return {
      level: 'low',
      reason: 'Пока мало предметности, поэтому риск потери низкий, но и атаковать рано.',
    };
  }
  if ((opportunity.economic_assessment?.expected_margin_percent ?? 0) < 15
    && opportunity.economic_assessment?.expected_margin_percent !== null) {
    return {
      level: 'low',
      reason: 'Даже при закрытии сделка пока не даёт нужной экономической ценности.',
    };
  }
  return {
    level: 'medium',
    reason: 'Сделка требует контроля, но критичных стоп-сигналов сейчас нет.',
  };
}

function buildAlternativeAction(opportunity, state, decision) {
  const currentActionCode = decision.recommended_action?.action_code ?? null;

  if (currentActionCode === 'send_offer') {
    if (opportunity.economic_assessment?.own_equipment_available) {
      return 'Зарезервировать свою технику';
    }
    if (state.states.some((item) => item.state_code === 'hot_subrent_only')) {
      return 'Передать в субаренду';
    }
  }

  if (currentActionCode === 'clarify_specs') {
    return 'Позвонить клиенту';
  }

  if (currentActionCode === 'request_subrent' && opportunity.economic_assessment?.own_equipment_available) {
    return 'Зарезервировать свою технику';
  }

  if (currentActionCode === 'sales_call' && opportunity.payment_readiness === 'ready_for_offer') {
    return 'Отправить КП';
  }

  if (currentActionCode === 'debt_control') {
    return 'Эскалировать на руководителя';
  }

  if (currentActionCode === 'stop_deal' && !state.states.some((item) => item.state_code === 'noise_low_priority')) {
    return 'Уточнить техпараметры';
  }

  return null;
}

function collectBlockingReasons(opportunity, state) {
  const blockingReasons = [];

  if (state.states.some((item) => item.state_code === 'spec_missing')) {
    blockingReasons.push('Нужны уточнения по техпараметрам.');
  }
  if (state.states.some((item) => item.state_code === 'debt_risk')) {
    blockingReasons.push('Есть риск по оплате или кредитным ограничениям.');
  }
  if (state.states.some((item) => item.state_code === 'hot_subrent_only')) {
    blockingReasons.push('Сделка зависит от субаренды.');
  }
  if (state.states.some((item) => item.state_code === 'extraction_low_confidence')) {
    blockingReasons.push('Низкая уверенность в объекте или технике, нужна ручная верификация.');
  }

  return blockingReasons;
}

function collectLowPriorityReasons(opportunity, state) {
  const lowPriorityReasons = [];

  if ((opportunity.economic_assessment?.expected_margin_percent ?? 0) < 15
    && opportunity.economic_assessment?.expected_margin_percent !== null) {
    lowPriorityReasons.push('Маржа ниже рабочего порога.');
  }
  if (state.states.some((item) => item.state_code === 'noise_low_priority')) {
    lowPriorityReasons.push('Сделка пока шумовая и слабо конкретизирована.');
  }
  if (!opportunity.next_step?.code && !opportunity.next_step?.description) {
    lowPriorityReasons.push('Не зафиксирован следующий шаг.');
  }
  if (state.states.some((item) => item.state_code === 'extraction_low_confidence')) {
    lowPriorityReasons.push('Сделку пока рано агрессивно атаковать: ключевые сущности распознаны неуверенно.');
  }

  return lowPriorityReasons;
}

function buildStopSignals(opportunity, state, decision) {
  const blockingReasons = collectBlockingReasons(opportunity, state);
  const lowPriorityReasons = collectLowPriorityReasons(opportunity, state);
  const strategyWarnings = [];
  const waitConditions = [];

  if ((opportunity.economic_assessment?.expected_margin_percent ?? 0) < 10
    && opportunity.economic_assessment?.expected_margin_percent !== null) {
    strategyWarnings.push('Экономика сделки близка к убыточной для текущей модели.');
  }
  if (opportunity.financial_risk?.client_blacklisted) {
    strategyWarnings.push('Клиент находится в стоп-контуре по политике компании.');
  }
  if (opportunity.financial_risk?.credit_limit_blocked) {
    strategyWarnings.push('Кредитный лимит клиента заблокирован.');
  }
  if (state.states.some((item) => item.state_code === 'spec_missing')) {
    waitConditions.push('Сначала дособрать технические параметры и условия заезда.');
  }
  if (state.states.some((item) => item.state_code === 'debt_risk')) {
    waitConditions.push('Сначала согласовать условия оплаты и снять финансовые ограничения.');
  }
  if (state.states.some((item) => item.state_code === 'noise_low_priority')) {
    waitConditions.push('Сначала подтвердить, что потребность реальная, а не шумовая.');
  }
  if (state.states.some((item) => item.state_code === 'hot_subrent_only')) {
    waitConditions.push('Сначала понять, доступна ли субаренда и укладывается ли она в маржу.');
  }
  if (state.states.some((item) => item.state_code === 'extraction_low_confidence')) {
    waitConditions.push('Сначала вручную подтвердить объект, технику и базовые условия запроса.');
  }
  if (!waitConditions.length && decision.recommended_action?.action_code === 'stop_deal') {
    waitConditions.push('Сейчас лучше не тратить ресурс команды, пока не появится предметность.');
  }

  return {
    blocked_reasons: blockingReasons,
    low_priority_reasons: lowPriorityReasons,
    strategy_warnings: strategyWarnings,
    wait_conditions: waitConditions,
  };
}

function buildQueueItem(opportunity, state, decision) {
  const blockingReasons = collectBlockingReasons(opportunity, state);
  const lowPriorityReasons = collectLowPriorityReasons(opportunity, state);
  const lossRisk = buildLossRiskSummary(opportunity, state);
  const alternativeAction = buildAlternativeAction(opportunity, state, decision);
  const priorityReasons = [];
  const nextStepDueAt = opportunity.next_step?.due_at ?? null;
  const promiseOverdue = state.states.some((item) => item.state_code === 'manager_promise_overdue');
  const slaBreached = state.states.some((item) => item.state_code === 'hot_unworked');

  if ((state.scores.need ?? 0) >= 4) {
    priorityReasons.push('need strong');
  }
  if ((state.scores.time ?? 0) >= 4) {
    priorityReasons.push('time critical');
  }
  if ((state.scores.money ?? 0) >= 4) {
    priorityReasons.push('money ready');
  }
  if ((state.scores.fit ?? 0) >= 4) {
    priorityReasons.push('fit high');
  }

  const signalMarkers = [];
  if (state.states.some((item) => item.state_code === 'client_ready_for_contract')) {
    signalMarkers.push('contract ready');
  }
  if (state.states.some((item) => item.state_code === 'decision_maker_reached')) {
    signalMarkers.push('decision access');
  }
  if (state.states.some((item) => item.state_code === 'spec_strong')) {
    signalMarkers.push('spec strong');
  }
  if (state.states.some((item) => item.state_code === 'extraction_low_confidence')) {
    signalMarkers.push('verify extraction');
  }

  return {
    opportunity_id: opportunity.id,
    bitrix_deal_id: opportunity.bitrix_deal_id,
    company: opportunity.company?.raw_value ?? null,
    object: opportunity.project_object?.raw_value ?? null,
    priority_score: state.priority_score,
    priority_bucket: toPriorityBucket(state.priority_score),
    next_action: decision.recommended_action?.action_name ?? null,
    next_action_code: decision.recommended_action?.action_code ?? null,
    target_role: decision.recommended_action?.target_role ?? null,
    recommended_owner: opportunity.owner_manager?.full_name
      ?? opportunity.contact_person?.raw_value
      ?? null,
    why_now: decision.explainability.why_important[0] ?? null,
    risk_summary: decision.explainability.risk_if_ignored ?? null,
    loss_risk_level: lossRisk.level,
    loss_risk_reason: lossRisk.reason,
    alternative_action: alternativeAction,
    next_step_due_at: nextStepDueAt,
    promise_overdue: promiseOverdue,
    sla_breached: slaBreached,
    deadline_at: decision.deadline_at,
    state_codes: state.states.map((item) => item.state_code),
    score_vector: state.scores,
    priority_reasons: priorityReasons,
    signal_markers: signalMarkers,
    why_blocked: blockingReasons,
    why_low_priority: lowPriorityReasons,
  };
}

async function getActionEffectivenessMap() {
  const feedback = await repository.getFeedbackLearningSummary(50);
  return new Map((feedback.action_metrics ?? []).map((item) => [item.action_code, item]));
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

function buildExtractionQuality(opportunity) {
  const events = opportunity.communication_events ?? [];
  const extractionEvents = events
    .map((event) => event.extraction_json ?? null)
    .filter(Boolean);

  const confidence = {
    company: opportunity.company?.confidence_score ?? null,
    object: opportunity.project_object?.confidence_score ?? null,
    person: opportunity.contact_person?.confidence_score ?? null,
    equipment: opportunity.equipment_type?.confidence_score ?? null,
  };

  const extractedSignalConfidence = {
    urgency: extractionEvents
      .map((item) => item.urgency?.confidence)
      .filter((value) => value !== null && value !== undefined),
    money: extractionEvents
      .map((item) => item.money_readiness?.confidence)
      .filter((value) => value !== null && value !== undefined),
    decision_access: extractionEvents
      .map((item) => item.decision_access?.confidence)
      .filter((value) => value !== null && value !== undefined),
    competitor: extractionEvents
      .map((item) => item.competitor?.confidence)
      .filter((value) => value !== null && value !== undefined),
    debt_risk: extractionEvents
      .map((item) => item.debt_risk?.confidence)
      .filter((value) => value !== null && value !== undefined),
  };

  const avg = (values) => values.length
    ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2))
    : null;

  const fieldConfidence = {
    ...confidence,
    urgency: avg(extractedSignalConfidence.urgency),
    money: avg(extractedSignalConfidence.money),
    decision_access: avg(extractedSignalConfidence.decision_access),
    competitor: avg(extractedSignalConfidence.competitor),
    debt_risk: avg(extractedSignalConfidence.debt_risk),
  };

  const lowConfidenceFields = Object.entries(fieldConfidence)
    .filter(([, value]) => value !== null && value < 0.7)
    .map(([key]) => key);

  return {
    extracted_events: extractionEvents.length,
    field_confidence: fieldConfidence,
    low_confidence_fields: lowConfidenceFields,
  };
}

function buildDecisionTimeline(stateHistory, recommendationsHistory, feedbackHistory) {
  const feedbackByRecommendationId = new Map();
  for (const item of feedbackHistory ?? []) {
    const key = item.recommendation_id ?? item.action_id;
    if (!key) continue;
    const current = feedbackByRecommendationId.get(key) ?? [];
    current.push(item);
    feedbackByRecommendationId.set(key, current);
  }

  const stateEntries = (stateHistory ?? []).map((item) => ({
    event_type: 'state',
    created_at: item.snapshot_time ?? null,
    title: item.state_code,
    subtitle: item.reason ?? null,
    payload: item,
  }));

  const recommendationEntries = (recommendationsHistory ?? []).map((item) => {
    const feedbackItems = feedbackByRecommendationId.get(item.id) ?? [];
    return {
      event_type: 'recommendation',
      created_at: item.created_at ?? null,
      title: item.action_code ?? 'recommendation',
      subtitle: item.status ?? null,
      payload: {
        ...item,
        feedback: feedbackItems,
      },
    };
  });

  const feedbackEntries = (feedbackHistory ?? []).map((item) => {
    let status = 'shown';
    if (item.executed) status = 'executed';
    else if (item.accepted) status = 'accepted';
    else if (item.rejected) status = 'rejected';

    return {
      event_type: 'feedback',
      created_at: item.recorded_at ?? null,
      title: `${item.action_code ?? 'recommendation'} · ${status}`,
      subtitle: item.rejection_reason ?? item.deal_result ?? null,
      payload: item,
    };
  });

  return [...stateEntries, ...recommendationEntries, ...feedbackEntries]
    .sort((left, right) => new Date(right.created_at ?? 0).getTime() - new Date(left.created_at ?? 0).getTime())
    .slice(0, 30);
}

export async function buildManagerDashboard() {
  const actionEffectiveness = await getActionEffectivenessMap();
  const opportunities = await repository.listOpportunities();
  return opportunities
    .map((opportunity) => {
      const state = evaluateOpportunityState(opportunity);
      const decision = decideNextAction(state, { action_effectiveness: actionEffectiveness });
      return {
        ...buildQueueItem(opportunity, state, decision),
        action_effectiveness: actionEffectiveness.get(decision.recommended_action?.action_code ?? '') ?? null,
      };
    })
    .sort((left, right) => right.priority_score - left.priority_score);
}

export async function buildRopDashboard() {
  const actionEffectiveness = await getActionEffectivenessMap();
  const opportunities = await repository.listOpportunities();
  return opportunities
    .map((opportunity) => {
      const state = evaluateOpportunityState(opportunity);
      const decision = decideNextAction(state, { action_effectiveness: actionEffectiveness });
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

      const signalMarkers = [
        ...(state.states.some((item) => item.state_code === 'client_ready_for_contract') ? ['contract ready'] : []),
        ...(state.states.some((item) => item.state_code === 'decision_maker_reached') ? ['decision access'] : []),
        ...(state.states.some((item) => item.state_code === 'spec_strong') ? ['spec strong'] : []),
        ...(state.states.some((item) => item.state_code === 'extraction_low_confidence') ? ['verify extraction'] : []),
      ];

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
        target_role: decision.recommended_action?.target_role ?? null,
        recommended_owner: opportunity.owner_manager?.full_name
          ?? opportunity.contact_person?.raw_value
          ?? null,
        recommendation_status: decision.escalation_action?.action_code ? 'needs_approval' : 'monitor',
        deadline_at: decision.deadline_at,
        next_step_due_at: opportunity.next_step?.due_at ?? null,
        promise_overdue: state.states.some((item) => item.state_code === 'manager_promise_overdue'),
        sla_breached: state.states.some((item) => item.state_code === 'hot_unworked'),
        action_effectiveness: actionEffectiveness.get(decision.recommended_action?.action_code ?? '') ?? null,
        signal_markers: signalMarkers,
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
  const actionEffectiveness = await getActionEffectivenessMap();
  const opportunities = await repository.listOpportunities();
  const items = opportunities
    .map((opportunity) => {
      const state = evaluateOpportunityState(opportunity);
      const decision = decideNextAction(state, { action_effectiveness: actionEffectiveness });
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
  const [feedback, opportunities, ingestIssues] = await Promise.all([
    repository.getFeedbackLearningSummary(50),
    repository.listOpportunities(),
    repository.listFailedIngestEvents(500),
  ]);
  const actionEffectiveness = new Map((feedback.action_metrics ?? []).map((item) => [item.action_code, item]));
  const items = opportunities
    .map((opportunity) => {
      const state = evaluateOpportunityState(opportunity);
      const decision = decideNextAction(state, { action_effectiveness: actionEffectiveness });
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

      const signalMarkers = [
        ...(state.states.some((item) => item.state_code === 'client_ready_for_contract') ? ['contract ready'] : []),
        ...(state.states.some((item) => item.state_code === 'decision_maker_reached') ? ['decision access'] : []),
        ...(state.states.some((item) => item.state_code === 'spec_strong') ? ['spec strong'] : []),
        ...(state.states.some((item) => item.state_code === 'extraction_low_confidence') ? ['verify extraction'] : []),
      ];

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
        signal_markers: signalMarkers,
      };
    })
    .filter((item) => {
      if (!strategy) return item.strategy_flag !== 'monitor';
      return item.strategy_flag === strategy;
    })
    .sort((left, right) => right.priority_score - left.priority_score)
    .slice(0, limit);

  const totalOpportunities = opportunities.length || 1;
  const ownEquipmentCount = opportunities.filter((item) => item.economic_assessment?.own_equipment_available === true).length;
  const subrentCount = opportunities.filter((item) => item.economic_assessment?.subrent_required === true).length;
  const debtRiskCount = opportunities.filter((item) =>
    (item.financial_risk?.debt_overdue_days ?? 0) > 0 || item.financial_risk?.credit_limit_blocked).length;
  const confidenceGuardCount = opportunities.filter((item) =>
    evaluateOpportunityState(item).states.some((state) => state.state_code === 'extraction_low_confidence')).length;
  const avgMarginSource = opportunities
    .map((item) => item.economic_assessment?.expected_margin_percent)
    .filter((value) => value !== null && value !== undefined);
  const averageMargin = avgMarginSource.length
    ? Number((avgMarginSource.reduce((sum, value) => sum + value, 0) / avgMarginSource.length).toFixed(1))
    : null;
  const failedIngestCount = ingestIssues.filter((item) => item.processing_status === 'failed').length;
  const suspiciousIngestCount = ingestIssues.filter((item) => item.processing_status === 'suspicious').length;
  const unresolvedIngestCount = ingestIssues.filter((item) =>
    String(item.error_message ?? '').toLowerCase().includes('unable to resolve opportunity')).length;

  return {
    summary: {
      total_opportunities: opportunities.length,
      own_equipment_share: Math.round((ownEquipmentCount / totalOpportunities) * 100),
      subrent_dependency_share: Math.round((subrentCount / totalOpportunities) * 100),
      debt_exposure_share: Math.round((debtRiskCount / totalOpportunities) * 100),
      confidence_guard_share: Math.round((confidenceGuardCount / totalOpportunities) * 100),
      average_margin_percent: averageMargin,
      recommendation_accepted_rate: Math.round((feedback.summary?.accepted_rate ?? 0) * 100),
      recommendation_executed_rate: Math.round((feedback.summary?.executed_rate ?? 0) * 100),
      ingest_failed_events: failedIngestCount,
      ingest_suspicious_events: suspiciousIngestCount,
      ingest_unresolved_events: unresolvedIngestCount,
    },
    items,
  };
}

export async function buildManagerQueue({ limit = 20, bucket = '', state = '', mode = '', search = '' } = {}) {
  const normalizedSearch = search.trim().toLowerCase();
  const items = await buildManagerDashboard();
  return items
    .filter((item) => !bucket || item.priority_bucket === bucket)
    .filter((item) => !state || item.state_codes.includes(state))
    .filter((item) => {
      if (!mode) return true;
      if (mode === 'verify') return item.state_codes.includes('extraction_low_confidence');
      if (mode === 'blocked') return (item.why_blocked?.length ?? 0) > 0;
      if (mode === 'low_priority') return (item.why_low_priority?.length ?? 0) > 0;
      if (mode === 'overdue') {
        return item.state_codes.includes('hot_unworked')
          || item.state_codes.includes('manager_promise_overdue');
      }
      if (mode === 'attack_now') {
        return (item.why_blocked?.length ?? 0) === 0
          && (item.why_low_priority?.length ?? 0) === 0
          && ['critical', 'high'].includes(item.priority_bucket);
      }
      return true;
    })
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
  const actionEffectiveness = await getActionEffectivenessMap();
  const decision = await evaluateAndPersistDecision(opportunity, actionEffectiveness);
  const stateHistory = await repository.listStateSnapshots(opportunityId);
  const recommendationsHistory = await repository.listRecommendations(opportunityId);
  const feedbackHistory = await repository.listFeedbackForOpportunity(opportunityId);
  const graph = buildOpportunityGraph(opportunity);
  const similarCases = await getSimilarCases(opportunity, repository);
  const riskEvidence = collectSignalEvidence(opportunity);
  const extractionQuality = buildExtractionQuality(opportunity);
  const decisionTimeline = buildDecisionTimeline(stateHistory, recommendationsHistory, feedbackHistory);
  const stopSignals = buildStopSignals(opportunity, state, decision);
  const topSimilarCase = similarCases[0] ?? null;
  const similarCaseSources = Array.from(new Set((similarCases ?? []).map((item) => item.source).filter(Boolean)));
  const similarActionAlignment = topSimilarCase?.recommended_action_hint
    ? (topSimilarCase.recommended_action_hint === decision.recommended_action?.action_code ? 'aligned' : 'different')
    : null;
  const recommendedActionEffectiveness = actionEffectiveness.get(decision.recommended_action?.action_code ?? '') ?? null;
  const consideredAlternatives = (decision.explainability?.considered_alternatives ?? []).map((item) => ({
    ...item,
    action_effectiveness: actionEffectiveness.get(item.action_code ?? '') ?? null,
  }));
  const decisionSupportMarkers = [
    ...(opportunity.graph_signals?.cross_sell_open ? ['graph:cross_sell'] : []),
    ...(opportunity.graph_signals?.competitor_present ? ['graph:competitor'] : []),
    ...(topSimilarCase ? [`semantic:${topSimilarCase.source ?? 'similar_case'}`] : []),
    ...(recommendedActionEffectiveness ? ['learning:feedback_history'] : []),
  ];
  const decisionSupportLevel = decisionSupportMarkers.length >= 3
    ? 'high'
    : decisionSupportMarkers.length >= 2
      ? 'medium'
      : decisionSupportMarkers.length >= 1
        ? 'light'
        : 'minimal';

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
      explainability: {
        ...decision.explainability,
        similar_case_hint: topSimilarCase
          ? `${topSimilarCase.title} · ${topSimilarCase.outcome} · ${topSimilarCase.source}${topSimilarCase.recommended_action_hint ? ` · action ${topSimilarCase.recommended_action_hint}` : ''}${similarActionAlignment ? ` · ${similarActionAlignment}` : ''}`
          : decision.explainability.similar_case_hint,
        learning_hint: recommendedActionEffectiveness
          ? `Исторически действие ${decision.recommended_action?.action_code} принимается в ${Math.round((recommendedActionEffectiveness.accepted_rate ?? 0) * 100)}% случаев и исполняется в ${Math.round((recommendedActionEffectiveness.executed_rate ?? 0) * 100)}% случаев.`
          : 'Пока недостаточно feedback-истории, чтобы оценить эффективность действия.',
        considered_alternatives: consideredAlternatives,
      },
      action_effectiveness: actionEffectiveness.get(decision.recommended_action?.action_code ?? '') ?? null,
    },
    recommendation_signals: {
      contract_ready: state.states.some((item) => item.state_code === 'client_ready_for_contract'),
      decision_access: state.states.some((item) => item.state_code === 'decision_maker_reached'),
      spec_strong: state.states.some((item) => item.state_code === 'spec_strong'),
      confidence_guard: state.states.some((item) => item.state_code === 'extraction_low_confidence'),
      markers: [
        ...(state.states.some((item) => item.state_code === 'client_ready_for_contract') ? ['contract ready'] : []),
        ...(state.states.some((item) => item.state_code === 'decision_maker_reached') ? ['decision access'] : []),
        ...(state.states.some((item) => item.state_code === 'spec_strong') ? ['spec strong'] : []),
        ...(state.states.some((item) => item.state_code === 'extraction_low_confidence') ? ['verify extraction'] : []),
      ],
    },
    decision_support: {
      support_level: decisionSupportLevel,
      graph_support: Boolean(opportunity.graph_signals?.cross_sell_open || opportunity.graph_signals?.competitor_present),
      semantic_support: Boolean(topSimilarCase),
      learning_support: Boolean(recommendedActionEffectiveness),
      confidence_guard: state.states.some((item) => item.state_code === 'extraction_low_confidence'),
      support_markers: decisionSupportMarkers,
    },
    communication_history: (opportunity.communication_events ?? []).slice(0, 12),
    risk_evidence: riskEvidence,
    extraction_quality: extractionQuality,
    stop_signals: stopSignals,
    similar_cases_summary: {
      total: similarCases.length,
      primary_source: topSimilarCase?.source ?? null,
      sources: similarCaseSources,
      vector_live: similarCaseSources.some((source) => source !== 'heuristic'),
    },
    similar_cases: similarCases,
    recommendations_history: recommendationsHistory,
    feedback_history: feedbackHistory,
    decision_timeline: decisionTimeline,
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
  const extractionQuality = buildExtractionQuality(opportunity);
  if (extractionQuality.low_confidence_fields.includes('object')) issues.push('object_low_confidence');
  if (extractionQuality.low_confidence_fields.includes('equipment')) issues.push('equipment_low_confidence');
  if (extractionQuality.low_confidence_fields.includes('person')) issues.push('person_low_confidence');
  if (evaluateOpportunityState(opportunity).states.some((item) => item.state_code === 'extraction_low_confidence')) {
    issues.push('confidence_guard_active');
  }
  return issues;
}

function buildIngestIssueMap(ingestEvents) {
  const byOpportunity = new Map();

  for (const event of ingestEvents) {
    try {
      const patch = buildBitrixEntityPatch(event.payload);
      const opportunityId = patch.kind === 'deal'
        ? String(patch.external_id)
        : (patch.opportunity_external_id ? String(patch.opportunity_external_id) : null);
      if (!opportunityId) continue;

      const issues = byOpportunity.get(opportunityId) ?? [];
      if (event.processing_status === 'suspicious') {
        issues.push('suspicious_ingest_match');
      }
      if (event.processing_status === 'failed') {
        issues.push('failed_ingest_event');
      }
      if (String(event.error_message ?? '').toLowerCase().includes('unable to resolve opportunity')) {
        issues.push('unresolved_ingest_event');
      }
      byOpportunity.set(opportunityId, Array.from(new Set(issues)));
    } catch {
      continue;
    }
  }

  return byOpportunity;
}

export async function buildDataQualityDashboard() {
  const [opportunities, failedIngest, normalizationResults] = await Promise.all([
    repository.listOpportunities(),
    repository.listFailedIngestEvents(200),
    repository.listNormalizationResults(1000),
  ]);

  const totalOpportunities = opportunities.length || 1;
  const ingestFailedCount = failedIngest.filter((item) => item.processing_status === 'failed').length;
  const ingestSuspiciousCount = failedIngest.filter((item) => item.processing_status === 'suspicious').length;
  const ingestUnresolvedCount = failedIngest.filter((item) =>
    String(item.error_message ?? '').toLowerCase().includes('unable to resolve opportunity')).length;
  const ingestIssueMap = buildIngestIssueMap(failedIngest);
  const opportunitiesWithIngestRisk = ingestIssueMap.size;
  const opportunitiesWithConfidenceGuard = opportunities.filter((item) =>
    evaluateOpportunityState(item).states.some((state) => state.state_code === 'extraction_low_confidence')).length;
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
      const ingestIssues = ingestIssueMap.get(String(opportunity.id)) ?? [];
      const issues = [...buildQualityIssues(opportunity), ...ingestIssues];
      return {
        opportunity_id: opportunity.id,
        company: opportunity.company?.raw_value ?? null,
        object: opportunity.project_object?.raw_value ?? null,
        quality_score: Math.max(0, 100 - (issues.length * 18)),
        issues,
        ingest_issues: ingestIssues,
        extraction_confidence: buildExtractionQuality(opportunity),
      };
    })
    .filter((item) => item.issues.length > 0)
    .sort((left, right) => left.quality_score - right.quality_score);
  const issueBreakdown = Array.from(
    items.reduce((accumulator, item) => {
      for (const issue of item.issues) {
        accumulator.set(issue, (accumulator.get(issue) ?? 0) + 1);
      }
      return accumulator;
    }, new Map()).entries(),
  )
    .map(([issue_code, count]) => ({ issue_code, count }))
    .sort((left, right) => right.count - left.count);

  return {
    summary: {
      total_opportunities: opportunities.length,
      linked_events_percent: Math.round((linkedEventsCount / totalOpportunities) * 100),
      normalized_objects_percent: Math.round((normalizedObjectsCount / totalOpportunities) * 100),
      opportunities_without_next_step: withoutNextStep,
      opportunities_missing_equipment: missingEquipment,
      failed_ingest_events: ingestFailedCount,
      suspicious_ingest_events: ingestSuspiciousCount,
      unresolved_ingest_events: ingestUnresolvedCount,
      opportunities_with_ingest_risk: opportunitiesWithIngestRisk,
      confidence_guard_events: opportunitiesWithConfidenceGuard,
      normalization_records: normalizationResults.length,
      critical_fields: coverageMetrics,
      issue_breakdown: issueBreakdown,
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
      address: item.address?.normalized_value ?? item.address?.raw_value ?? null,
      equipment: item.equipment_type?.normalized_value ?? item.equipment_type?.raw_value ?? null,
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
      role: item.contact_person.role ?? null,
      company: item.company?.normalized_value ?? item.company?.raw_value ?? null,
    }));

  const candidates = [
    ...findDuplicateCandidates(companies, {
      kind: 'company',
      getReferenceId: (item) => `${item.opportunity_id}:${item.resolved_entity_id ?? item.raw_value}`,
    }),
    ...findContextualDuplicateCandidates(objects, {
      kind: 'object',
      threshold: 0.74,
      getReferenceId: (item) => `${item.opportunity_id}:${item.resolved_entity_id ?? item.raw_value}`,
      getContext: (item) => ({
        address: item.address,
        equipment: item.equipment,
      }),
    }),
    ...findContextualDuplicateCandidates(persons, {
      kind: 'person',
      threshold: 0.8,
      getReferenceId: (item) => `${item.opportunity_id}:${item.resolved_entity_id ?? item.raw_value}`,
      getContext: (item) => ({
        role: item.role,
        company: item.company,
      }),
    }),
  ]
    .map((item) => {
      const priority = item.similarity_score >= 0.92
        ? 'merge_now'
        : item.similarity_score >= 0.84
          ? 'review_fast'
          : 'review';
      return {
        ...item,
        merge_priority: priority,
        suggested_action: priority === 'merge_now'
          ? 'Объединить автоматически после проверки'
          : priority === 'review_fast'
            ? 'Проверить и объединить вручную в первую очередь'
            : 'Оставить в очереди на ручную верификацию',
      };
    })
    .sort((left, right) => right.similarity_score - left.similarity_score)
    .slice(0, 50);
  const priorityBreakdown = ['merge_now', 'review_fast', 'review']
    .map((priority_code) => ({
      priority_code,
      count: candidates.filter((item) => item.merge_priority === priority_code).length,
    }))
    .filter((item) => item.count > 0);

  return {
    summary: {
      companies_seen: companies.length,
      objects_seen: objects.length,
      persons_seen: persons.length,
      duplicate_candidates: candidates.length,
      priority_breakdown: priorityBreakdown,
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

      if (request.method === 'POST' && url.pathname === '/events/bitrix/retry') {
        const denied = requirePermission(auth, 'dashboard.data_quality');
        if (denied) return sendJson(response, 403, denied);
        const payload = await readJson(request).catch(() => ({}));
        const limit = Number(payload?.limit ?? 50);
        const processAfterRetry = payload?.process_after_retry === true;
        const statuses = Array.isArray(payload?.statuses) && payload.statuses.length
          ? payload.statuses
          : ['failed', 'suspicious'];
        const result = await repository.retryIngestEvents({ statuses, limit });
        const processed = processAfterRetry
          ? await repository.processPendingIngestEvents(limit)
          : null;
        await writeAuditLog(auth, 'bitrix_ingest_retry', 'ingest_batch', `retry:${Date.now()}`, {
          retried_count: result.retried_count,
          statuses,
          process_after_retry: processAfterRetry,
          processed_count: processed?.processed_count ?? 0,
        });
        return sendJson(response, 200, {
          ok: true,
          ...result,
          processed,
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
            mode: url.searchParams.get('mode') ?? '',
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
        return sendJson(response, 200, await buildOwnerDashboard({
          limit: Number(url.searchParams.get('limit') ?? 20),
          strategy: url.searchParams.get('strategy') ?? '',
        }));
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
