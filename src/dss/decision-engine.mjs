import { getAction } from './action-library.mjs';

const STATE_TO_ACTION = [
  {
    state: 'hot_unworked',
    action: 'sales_call',
    escalation: 'owner_escalation',
    priority: 95,
    why: 'Горячая сделка простаивает дольше SLA.',
  },
  {
    state: 'hot_urgent',
    action: 'send_offer',
    escalation: null,
    priority: 78,
    why: 'Клиент созрел до быстрой коммерческой реакции.',
  },
  {
    state: 'client_ready_for_contract',
    action: 'send_contract',
    escalation: null,
    priority: 92,
    why: 'Сделка дошла до договорной зрелости, нужно быстро перевести ее в оформление.',
  },
  {
    state: 'hot_own_equipment',
    action: 'reserve_own_equipment',
    escalation: 'reprice_deal',
    priority: 84,
    why: 'Есть смысл закрепить свою технику, пока окно не ушло.',
  },
  {
    state: 'hot_subrent_only',
    action: 'request_subrent',
    escalation: 'owner_escalation',
    priority: 82,
    why: 'Спрос реальный, но без субаренды шанс потерять сделку высокий.',
  },
  {
    state: 'spec_missing',
    action: 'clarify_specs',
    escalation: null,
    priority: 72,
    why: 'Без уточнений система не рекомендует агрессивный дожим.',
  },
  {
    state: 'object_access_unclear',
    action: 'clarify_object_access',
    escalation: null,
    priority: 71,
    why: 'Нужны уточнения по объекту и условиям доступа до логистического коммита.',
  },
  {
    state: 'decision_maker_reached',
    action: 'sales_call',
    escalation: null,
    priority: 80,
    why: 'Есть доступ к принимающему решение, стоит использовать окно прямого контакта.',
  },
  {
    state: 'client_intent_confirmed',
    action: 'sales_call',
    escalation: null,
    priority: 81,
    why: 'Клиент явно обозначил следующий шаг, важно быстро закрепить инициативу.',
  },
  {
    state: 'price_context_known',
    action: 'send_offer',
    escalation: null,
    priority: 77,
    why: 'Ценовой контекст уже понятен, поэтому можно быстрее переходить к коммерческому действию.',
  },
  {
    state: 'logistics_context_ready',
    action: 'clarify_object_access',
    escalation: null,
    priority: 74,
    why: 'Есть условия работы и доступа, их стоит быстро превратить в логистически исполнимый сценарий.',
  },
  {
    state: 'competitor_attack_window',
    action: 'competitor_attack',
    escalation: 'owner_escalation',
    priority: 86,
    why: 'На объекте есть окно для атаки конкурента, и его лучше не терять.',
  },
  {
    state: 'cross_sell_open',
    action: 'cross_sell_offer',
    escalation: null,
    priority: 76,
    why: 'По графу виден соседний спрос, есть шанс расширить сделку через кросс-продажу.',
  },
  {
    state: 'debt_risk',
    action: 'debt_control',
    escalation: 'owner_escalation',
    priority: 98,
    why: 'Нужна проверка финансовых ограничений перед обещаниями клиенту.',
  },
  {
    state: 'noise_low_priority',
    action: 'stop_deal',
    escalation: null,
    priority: 99,
    why: 'Шумовую сделку лучше не перегревать ресурсами команды.',
  },
  {
    state: 'manager_promise_overdue',
    action: 'follow_up_reminder',
    escalation: 'owner_escalation',
    priority: 88,
    why: 'Просроченное обещание менеджера требует немедленного возврата сделки в работу.',
  },
  {
    state: 'low_margin_warning',
    action: 'reprice_deal',
    escalation: null,
    priority: 79,
    why: 'Маржа ниже целевого уровня, поэтому сначала нужен пересчет ставки.',
  },
  {
    state: 'low_margin_blocked',
    action: 'reprice_deal',
    escalation: 'owner_escalation',
    priority: 96,
    why: 'Маржа ниже допустимого порога, решение требует пересчета и управленческого контроля.',
  },
  {
    state: 'negative_margin_blocked',
    action: 'stop_deal',
    escalation: 'owner_escalation',
    priority: 100,
    why: 'Сделка уходит в отрицательную маржу, стандартная обработка запрещена.',
  },
  {
    state: 'blacklist_blocked',
    action: 'stop_deal',
    escalation: 'owner_escalation',
    priority: 100,
    why: 'Клиент в стоп-контуре, обещания и коммиты должны быть заблокированы.',
  },
];

function getEffectivenessBonus(actionEffectiveness) {
  if (!actionEffectiveness) return 0;
  const total = actionEffectiveness.total ?? 0;
  if (total < 2) return 0;
  const accepted = actionEffectiveness.accepted_rate ?? 0;
  const executed = actionEffectiveness.executed_rate ?? 0;
  const rejected = actionEffectiveness.rejected_rate ?? 0;
  return Number(((accepted * 4) + (executed * 6) - (rejected * 5)).toFixed(2));
}

function getExtractionGuardPenalty(opportunityState, actionCode) {
  const extractionLowConfidence = opportunityState.states.find((state) => state.state_code === 'extraction_low_confidence');
  if (!extractionLowConfidence) return 0;

  if (['send_offer', 'send_contract', 'reserve_own_equipment', 'cross_sell_offer', 'competitor_attack'].includes(actionCode)) {
    return 18;
  }
  if (['sales_call', 'request_subrent', 'reprice_deal', 'follow_up_reminder', 'clarify_object_access'].includes(actionCode)) {
    return 8;
  }
  if (['clarify_specs', 'clarify_object_access'].includes(actionCode)) {
    return -6;
  }

  return 0;
}

export function decideNextAction(opportunityState, options = {}) {
  const actionEffectiveness = options.action_effectiveness ?? null;
  const extractionLowConfidence = opportunityState.states.find((state) => state.state_code === 'extraction_low_confidence');
  const matchedRules = STATE_TO_ACTION
    .map((rule) => {
      const matchedState = opportunityState.states.find((state) => state.state_code === rule.state);
      if (!matchedState) return null;
      const effectiveness = actionEffectiveness?.get?.(rule.action) ?? null;
      const extractionPenalty = getExtractionGuardPenalty(opportunityState, rule.action);
      return {
        ...rule,
        matched_state: matchedState,
        effectiveness,
        extraction_penalty: extractionPenalty,
        selection_score: Number((
          rule.priority
          + (matchedState.confidence_score ?? 0) * 10
          + getEffectivenessBonus(effectiveness)
          - extractionPenalty
        ).toFixed(2)),
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.selection_score - left.selection_score);

  const matched = matchedRules[0] ?? null;
  const consideredAlternatives = matchedRules
    .slice(1, 4)
    .map((rule) => {
      const alternativeAction = getAction(rule.action);
      return {
        action_code: alternativeAction?.action_code ?? rule.action,
        action_name: alternativeAction?.action_name ?? rule.action,
        state_code: rule.matched_state.state_code,
        selection_score: rule.selection_score,
        action_effectiveness: rule.effectiveness,
        why_not_selected: rule.extraction_penalty > 0
          ? `Уступило из-за защитного штрафа за низкую уверенность в extraction (${rule.extraction_penalty}).`
          : `Уступило правилу ${matched?.matched_state.state_code ?? 'default'} по итоговому приоритету выбора.`,
      };
    });

  const action = getAction(matched?.action ?? 'clarify_specs');
  const escalation = matched?.escalation ? getAction(matched.escalation) : null;
  const topStates = opportunityState.states.slice(0, 3);

  return {
    opportunity_id: opportunityState.opportunity_id,
    recommended_action: action,
    escalation_action: escalation,
    deadline_at: new Date(Date.now() + ((action?.deadline_sla_minutes ?? 60) * 60_000)).toISOString(),
    explainability: {
      why_important: topStates.map((state) => state.reason),
      triggered_signals: topStates.map((state) => state.state_code),
      similar_case_hint: opportunityState.states.some((state) => state.state_code === 'cross_sell_open')
        ? 'Граф связей показывает соседний спрос на объекте, это усиливает сценарий расширения.'
        : opportunityState.states.some((state) => state.state_code === 'competitor_attack_window')
          ? 'По объекту есть сигнал конкурента, поэтому действие смещается в сторону управленческой атаки.'
          : 'В v1 это место зарезервировано под поиск похожих кейсов через Qdrant.',
      why_this_action: matched
        ? `${matched.why} Выбор сделан по состоянию ${matched.matched_state.state_code} с confidence ${matched.matched_state.confidence_score}${matched.effectiveness ? ` и learning bonus ${getEffectivenessBonus(matched.effectiveness)}` : ''}${matched.extraction_penalty > 0 ? ` при этом учтен extraction guard ${matched.extraction_penalty}.` : extractionLowConfidence ? ' Сработал мягкий confidence guard: система избегает слишком агрессивного действия до верификации ключевых сущностей.' : '.'}`
        : 'Базовое действие по умолчанию — дособрать недостающие данные.',
      considered_alternatives: consideredAlternatives,
      risk_if_ignored: escalation
        ? 'При бездействии рекомендация должна быть эскалирована руководителю.'
        : 'При бездействии окно сделки может остыть или потерять точность.',
    },
  };
}
