function clampScore(value) {
  return Math.max(0, Math.min(5, value));
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getExtractionConfidenceProfile(opportunity) {
  const events = opportunity.communication_events ?? [];
  const extractionEvents = events
    .map((event) => event.extraction_json ?? null)
    .filter(Boolean);
  const objectConfidence = opportunity.project_object?.confidence_score ?? null;
  const equipmentConfidence = opportunity.equipment_type?.confidence_score ?? null;
  const decisionAccessConfidence = average(
    extractionEvents
      .map((item) => item.decision_access?.confidence)
      .filter((value) => value !== null && value !== undefined),
  );

  const lowObject = objectConfidence !== null && objectConfidence < 0.65;
  const lowEquipment = equipmentConfidence !== null && equipmentConfidence < 0.65;
  const lowDecisionAccess = decisionAccessConfidence !== null && decisionAccessConfidence < 0.65;

  return {
    object: objectConfidence,
    equipment: equipmentConfidence,
    decision_access: decisionAccessConfidence,
    low_object: lowObject,
    low_equipment: lowEquipment,
    low_decision_access: lowDecisionAccess,
    has_critical_gap: lowObject || lowEquipment,
  };
}

function scoreNeed(opportunity) {
  let score = 0;
  if (opportunity.project_object?.normalized_value) score += 1.5;
  if (opportunity.equipment_type?.normalized_value) score += 1.5;
  if (opportunity.time_window?.start_at) score += 1;
  if ((opportunity.communication_events ?? []).length >= 2) score += 1;
  if (opportunity.commercial_scenario) score += 1;
  if (opportunity.commercial_stage === 'offer_requested' || opportunity.commercial_stage === 'contract_requested') score += 0.5;
  const confidence = getExtractionConfidenceProfile(opportunity);
  if (confidence.low_object) score -= 0.75;
  if (confidence.low_equipment) score -= 0.5;
  return clampScore(score);
}

function scoreTime(opportunity) {
  if (!opportunity.time_window?.start_at) {
    return 1;
  }

  const startAt = new Date(opportunity.time_window.start_at).getTime();
  const now = Date.now();
  const hours = (startAt - now) / 3_600_000;

  if (hours <= 24) return 5;
  if (hours <= 72) return 4;
  if (hours <= 168) return 3;
  if (hours <= 336) return 2;
  return 1;
}

function scoreSpec(opportunity) {
  let score = 0;
  if (opportunity.equipment_type?.normalized_value) score += 2;
  if (opportunity.technical_requirements?.length) score += 1.5;
  if ((opportunity.technical_requirements?.length ?? 0) >= 2) score += 0.5;
  if (opportunity.time_window?.duration_days) score += 0.75;
  if (opportunity.project_object?.normalized_value) score += 0.75;
  const confidence = getExtractionConfidenceProfile(opportunity);
  if (confidence.low_equipment) score -= 1.25;
  if (confidence.low_object) score -= 0.5;
  return clampScore(score);
}

function scoreAccess(opportunity) {
  let score = 1;
  if (opportunity.decision_access_status === 'decision_maker') score += 2.5;
  if (opportunity.decision_access_status === 'influencer') score += 1;
  if (opportunity.contact_person?.role?.toLowerCase().includes('лпр')) score += 1.5;
  if (opportunity.contact_person?.influence_score >= 0.7) score += 1;
  return clampScore(score);
}

function scoreMoney(opportunity) {
  let score = 0.5;
  if (opportunity.commercial_stage === 'offer_requested') score += 1.5;
  if (opportunity.commercial_stage === 'contract_requested') score += 2.5;
  if (opportunity.commercial_stage === 'invoice_requested') score += 2;
  if (opportunity.payment_readiness === 'commercial') score += 0.5;
  if (opportunity.payment_readiness === 'ready') score += 1;
  if (opportunity.financial_risk?.debt_overdue_days > 0) score -= 2;
  return clampScore(score);
}

function scoreFit(opportunity) {
  let score = 0.5;
  if (opportunity.economic_assessment?.own_equipment_available) score += 2.5;
  if (opportunity.economic_assessment?.expected_margin_percent >= 25) score += 1.5;
  if (opportunity.economic_assessment?.subrent_required) score -= 0.5;
  if (opportunity.financial_risk?.client_blacklisted) score = 0;
  return clampScore(score);
}

function addState(states, state_code, reason, confidence_score) {
  states.push({
    state_code,
    confidence_score: Number(confidence_score.toFixed(2)),
    reason,
    timestamp: new Date().toISOString(),
  });
}

export function calculateScores(opportunity) {
  const overriddenScores = opportunity.source_scores;
  if (
    overriddenScores
    && ['need', 'time', 'spec', 'access', 'money', 'fit'].every((key) => overriddenScores[key] !== null && overriddenScores[key] !== undefined)
  ) {
    return {
      need: clampScore(overriddenScores.need),
      time: clampScore(overriddenScores.time),
      spec: clampScore(overriddenScores.spec),
      access: clampScore(overriddenScores.access),
      money: clampScore(overriddenScores.money),
      fit: clampScore(overriddenScores.fit),
    };
  }

  return {
    need: scoreNeed(opportunity),
    time: scoreTime(opportunity),
    spec: scoreSpec(opportunity),
    access: scoreAccess(opportunity),
    money: scoreMoney(opportunity),
    fit: scoreFit(opportunity),
  };
}

export function calculatePriorityScore(opportunity, scores) {
  const confidence = getExtractionConfidenceProfile(opportunity);
  const pclose = (scores.need + scores.access + scores.money) / 15;
  const econValue = Math.max(0.1, (opportunity.economic_assessment?.expected_margin_percent ?? 10) / 100);
  const urgency = scores.time / 5;
  const fit = scores.fit / 5;
  const actionability = (scores.spec + scores.access) / 10;
  const strategyWeight = opportunity.strategy_weight ?? 1;

  let priority = pclose * econValue * urgency * fit * actionability * strategyWeight * 100;

  if (!opportunity.economic_assessment?.own_equipment_available && opportunity.financial_risk?.debt_overdue_days > 30) {
    priority *= 0.3;
  }

  if ((opportunity.economic_assessment?.expected_margin_percent ?? 0) < 0) {
    priority = 0;
  }

  if (confidence.low_object && confidence.low_equipment) {
    priority *= 0.55;
  } else if (confidence.has_critical_gap) {
    priority *= 0.72;
  }

  return Number(priority.toFixed(2));
}

export function evaluateOpportunityState(opportunity) {
  const scores = calculateScores(opportunity);
  const confidence = getExtractionConfidenceProfile(opportunity);
  const states = [];
  const lastTouchHours = opportunity.last_touch_at
    ? (Date.now() - new Date(opportunity.last_touch_at).getTime()) / 3_600_000
    : null;
  const ownEquipmentAvailable = opportunity.economic_assessment?.own_equipment_available === true;
  const subrentRequired = opportunity.economic_assessment?.subrent_required === true;
  const debtRiskDetected = (opportunity.financial_risk?.debt_overdue_days ?? 0) > 0 || opportunity.financial_risk?.credit_limit_blocked;

  if (scores.need >= 4 && scores.time >= 4 && scores.money >= 3 && !confidence.has_critical_gap) {
    addState(states, 'hot_urgent', 'Потребность конкретная, окно мобилизации близко, клиент дошел до коммерческой стадии.', 0.88);
  }

  if (scores.money >= 4 && opportunity.commercial_stage === 'contract_requested') {
    addState(states, 'client_ready_for_contract', 'Клиент дошел до договорного шага и не требует длинного прогрева.', 0.87);
  }

  if (scores.access >= 4 && opportunity.decision_access_status === 'decision_maker' && !confidence.low_decision_access) {
    addState(states, 'decision_maker_reached', 'Контакт близок к принимающему решение, окно влияния сильное.', 0.82);
  }

  if (scores.spec >= 4 && !confidence.has_critical_gap) {
    addState(states, 'spec_strong', 'Техника и условия достаточно конкретизированы для уверенного предложения.', 0.78);
  }

  if (confidence.has_critical_gap) {
    addState(
      states,
      'extraction_low_confidence',
      'Ключевые сущности сделки распознаны неуверенно, сначала нужна верификация объекта или техники.',
      confidence.low_object && confidence.low_equipment ? 0.9 : 0.78,
    );
  }

  if (scores.fit >= 4 && ownEquipmentAvailable) {
    addState(states, 'hot_own_equipment', 'Сделка хорошо ложится на свой парк и свою экономику.', 0.86);
  }

  if (scores.need >= 4 && subrentRequired) {
    addState(states, 'hot_subrent_only', 'Сделка живая, но своя техника недоступна.', 0.79);
  }

  if (lastTouchHours !== null && lastTouchHours > (opportunity.sla_hours ?? 4) && scores.need >= 3.5) {
    addState(states, 'hot_unworked', 'По горячей сделке превышен SLA реакции.', 0.9);
  }

  if (scores.spec < 2.5) {
    addState(states, 'spec_missing', 'Не хватает технической конкретики для уверенной обработки.', 0.83);
  }

  if (scores.need < 2 && scores.spec < 2 && scores.time < 2) {
    addState(states, 'noise_low_priority', 'Сделка пока шумовая и не готова к активной обработке.', 0.76);
  }

  if ((opportunity.financial_risk?.debt_overdue_days ?? 0) > 15 || opportunity.financial_risk?.credit_limit_blocked) {
    addState(states, 'debt_risk', 'У клиента есть финансовые ограничения или просрочка.', 0.89);
  } else if (debtRiskDetected) {
    addState(states, 'debt_risk', 'В коммуникациях замечены признаки риска оплаты, нужна проверка условий.', 0.72);
  }

  if (opportunity.graph_signals?.cross_sell_open) {
    addState(states, 'cross_sell_open', 'По объекту виден соседний спрос в связях.', 0.72);
  }

  if (opportunity.graph_signals?.competitor_present && scores.fit >= 3) {
    addState(states, 'competitor_attack_window', 'На объекте замечен конкурент, но шанс перехвата высокий.', 0.7);
  }

  if (opportunity.next_step?.due_at && new Date(opportunity.next_step.due_at).getTime() < Date.now()) {
    addState(states, 'manager_promise_overdue', 'Обещанный follow-up просрочен.', 0.93);
  }

  return {
    opportunity_id: opportunity.id,
    scores,
    priority_score: calculatePriorityScore(opportunity, scores),
    states,
  };
}
