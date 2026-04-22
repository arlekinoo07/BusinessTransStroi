export const bitrixEventSchema = {
  type: 'object',
  required: ['source', 'entity_type', 'entity_id', 'event_type', 'payload'],
  properties: {
    source: { type: 'string', const: 'bitrix24' },
    entity_type: { type: 'string', enum: ['lead', 'deal', 'company', 'contact', 'activity', 'comment', 'task'] },
    entity_id: { type: 'string' },
    event_type: { type: 'string' },
    occurred_at: { type: 'string', format: 'date-time' },
    payload: { type: 'object' },
  },
};

export const normalizationResultSchema = {
  type: 'object',
  required: ['raw_value', 'normalized_value', 'confidence_score', 'resolved_entity_id'],
  properties: {
    raw_value: { type: 'string' },
    normalized_value: { type: ['string', 'null'] },
    confidence_score: { type: 'number', minimum: 0, maximum: 1 },
    resolved_entity_id: { type: ['string', 'null'] },
  },
};

export const opportunityUnitSchema = {
  type: 'object',
  required: ['id', 'bitrix_deal_id'],
  properties: {
    id: { type: 'string' },
    bitrix_deal_id: { type: 'string' },
    company: normalizationResultSchema,
    contact_person: {
      type: ['object', 'null'],
      properties: {
        raw_value: { type: 'string' },
        normalized_value: { type: 'string' },
        role: { type: ['string', 'null'] },
        influence_score: { type: ['number', 'null'] },
        trust_score: { type: ['number', 'null'] },
        confidence_score: { type: ['number', 'null'] },
        resolved_entity_id: { type: ['string', 'null'] },
      },
    },
    project_object: normalizationResultSchema,
    address: {
      type: ['object', 'null'],
      properties: normalizationResultSchema.properties,
    },
    equipment_type: {
      type: ['object', 'null'],
      properties: normalizationResultSchema.properties,
    },
    time_window: {
      type: ['object', 'null'],
      properties: {
        start_at: { type: ['string', 'null'], format: 'date-time' },
        duration_days: { type: ['number', 'null'] },
      },
    },
    commercial_scenario: { type: ['string', 'null'] },
    decision_access_status: { type: ['string', 'null'] },
    commercial_stage: { type: ['string', 'null'] },
    payment_readiness: { type: ['string', 'null'] },
    technical_requirements: {
      type: 'array',
      items: { type: 'string' },
    },
    economic_assessment: {
      type: ['object', 'null'],
      properties: {
        expected_margin_percent: { type: ['number', 'null'] },
        own_equipment_available: { type: ['boolean', 'null'] },
        subrent_required: { type: ['boolean', 'null'] },
      },
    },
    financial_risk: {
      type: ['object', 'null'],
      properties: {
        debt_overdue_days: { type: ['number', 'null'] },
        credit_limit_blocked: { type: ['boolean', 'null'] },
        client_blacklisted: { type: ['boolean', 'null'] },
      },
    },
    next_step: {
      type: ['object', 'null'],
      properties: {
        code: { type: ['string', 'null'] },
        due_at: { type: ['string', 'null'], format: 'date-time' },
        description: { type: ['string', 'null'] },
      },
    },
    last_touch_at: { type: ['string', 'null'], format: 'date-time' },
    strategy_weight: { type: ['number', 'null'] },
    sla_hours: { type: ['number', 'null'] },
    communication_events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string' },
          channel: { type: 'string' },
          summary: { type: 'string' },
          text: { type: 'string' },
        },
      },
    },
  },
};

export const recommendationFeedbackSchema = {
  type: 'object',
  properties: {
    shown: { type: 'boolean' },
    accepted: { type: 'boolean' },
    rejected: { type: 'boolean' },
    rejection_reason: { type: ['string', 'null'] },
    executed: { type: 'boolean' },
    deal_result: { type: ['string', 'null'] },
    effect_after_1_day: { type: ['string', 'null'] },
    effect_after_3_days: { type: ['string', 'null'] },
    effect_after_7_days: { type: ['string', 'null'] },
    effect_after_30_days: { type: ['string', 'null'] },
    result_after_days: { type: ['string', 'null'] },
  },
};

export const managerQueueItemSchema = {
  type: 'object',
  properties: {
    opportunity_id: { type: 'string' },
    bitrix_deal_id: { type: ['string', 'null'] },
    company: { type: ['string', 'null'] },
    object: { type: ['string', 'null'] },
    priority_score: { type: 'number' },
    priority_bucket: { type: 'string' },
    next_action: { type: ['string', 'null'] },
    next_action_code: { type: ['string', 'null'] },
    target_role: { type: ['string', 'null'] },
    recommended_owner: { type: ['string', 'null'] },
    why_now: { type: ['string', 'null'] },
    risk_summary: { type: ['string', 'null'] },
    loss_risk_level: { type: ['string', 'null'] },
    loss_risk_reason: { type: ['string', 'null'] },
    alternative_action: { type: ['string', 'null'] },
    next_step_due_at: { type: ['string', 'null'], format: 'date-time' },
    promise_overdue: { type: 'boolean' },
    sla_breached: { type: 'boolean' },
    deadline_at: { type: ['string', 'null'], format: 'date-time' },
    state_codes: {
      type: 'array',
      items: { type: 'string' },
    },
    score_vector: {
      type: 'object',
      properties: {
        need: { type: 'number' },
        time: { type: 'number' },
        spec: { type: 'number' },
        access: { type: 'number' },
        money: { type: 'number' },
        fit: { type: 'number' },
      },
    },
    action_effectiveness: {
      type: ['object', 'null'],
      properties: {
        action_code: { type: 'string' },
        total: { type: 'number' },
        accepted_rate: { type: 'number' },
        executed_rate: { type: 'number' },
        rejected_rate: { type: 'number' },
      },
    },
    why_blocked: {
      type: 'array',
      items: { type: 'string' },
    },
    why_low_priority: {
      type: 'array',
      items: { type: 'string' },
    },
    priority_reasons: {
      type: 'array',
      items: { type: 'string' },
    },
  },
};

export const opportunityCardSchema = {
  type: 'object',
  properties: {
    opportunity_id: { type: 'string' },
    bitrix_deal_id: { type: ['string', 'null'] },
    summary: {
      type: 'object',
      properties: {
        company: { type: ['string', 'null'] },
        contact: { type: ['string', 'null'] },
        object: { type: ['string', 'null'] },
        equipment_type: { type: ['string', 'null'] },
        commercial_stage: { type: ['string', 'null'] },
        last_touch_at: { type: ['string', 'null'], format: 'date-time' },
      },
    },
    opportunity_unit: opportunityUnitSchema,
    score_vector: managerQueueItemSchema.properties.score_vector,
    priority_score: { type: 'number' },
    states: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          state_code: { type: 'string' },
          confidence_score: { type: 'number' },
          reason: { type: 'string' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
    },
    recommendation: {
      type: 'object',
      properties: {
        recommendation_id: { type: ['string', 'null'] },
        recommendation_status: { type: ['string', 'null'] },
        action_code: { type: ['string', 'null'] },
        action_name: { type: ['string', 'null'] },
        target_role: { type: ['string', 'null'] },
        deadline_at: { type: ['string', 'null'], format: 'date-time' },
        escalation_action_code: { type: ['string', 'null'] },
        explainability: { type: 'object' },
        action_effectiveness: managerQueueItemSchema.properties.action_effectiveness,
      },
    },
    risk_evidence: {
      type: 'object',
      properties: {
        flags: {
          type: 'object',
          properties: {
            competitor_present: { type: 'boolean' },
            debt_risk: { type: 'boolean' },
            subrent_required: { type: 'boolean' },
            manager_promise_overdue: { type: 'boolean' },
          },
        },
        counters: {
          type: 'object',
          properties: {
            communication_events: { type: 'number' },
            competitor_mentions: { type: 'number' },
            debt_markers: { type: 'number' },
            subrent_markers: { type: 'number' },
            promise_markers: { type: 'number' },
            ignored_noise_events: { type: 'number' },
          },
        },
        evidence: { type: 'object' },
      },
    },
    stop_signals: {
      type: 'object',
      properties: {
        blocked_reasons: {
          type: 'array',
          items: { type: 'string' },
        },
        low_priority_reasons: {
          type: 'array',
          items: { type: 'string' },
        },
        strategy_warnings: {
          type: 'array',
          items: { type: 'string' },
        },
        wait_conditions: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    },
    similar_cases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          outcome: { type: 'string' },
          hint: { type: 'string' },
          source: { type: ['string', 'null'] },
          score: { type: ['number', 'null'] },
          match_reasons: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    },
    feedback_history: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          recommendation_id: { type: ['string', 'null'] },
          action_code: { type: ['string', 'null'] },
          accepted: { type: 'boolean' },
          rejected: { type: 'boolean' },
          executed: { type: 'boolean' },
          deal_result: { type: ['string', 'null'] },
          effect_after_1_day: { type: ['string', 'null'] },
          effect_after_3_days: { type: ['string', 'null'] },
          effect_after_7_days: { type: ['string', 'null'] },
          effect_after_30_days: { type: ['string', 'null'] },
          recorded_at: { type: ['string', 'null'], format: 'date-time' },
        },
      },
    },
    decision_timeline: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          event_type: { type: 'string' },
          created_at: { type: ['string', 'null'], format: 'date-time' },
          title: { type: ['string', 'null'] },
          subtitle: { type: ['string', 'null'] },
          payload: { type: 'object' },
        },
      },
    },
    recommendations_history: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: ['string', 'null'] },
          action_code: { type: ['string', 'null'] },
          status: { type: ['string', 'null'] },
          deadline_at: { type: ['string', 'null'], format: 'date-time' },
          created_at: { type: ['string', 'null'], format: 'date-time' },
        },
      },
    },
    state_history: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          state_code: { type: 'string' },
          snapshot_time: { type: ['string', 'null'], format: 'date-time' },
          reason: { type: ['string', 'null'] },
        },
      },
    },
  },
};

export const ropEscalationItemSchema = {
  type: 'object',
  properties: {
    opportunity_id: { type: 'string' },
    bitrix_deal_id: { type: ['string', 'null'] },
    company: { type: ['string', 'null'] },
    object: { type: ['string', 'null'] },
    priority_score: { type: 'number' },
    escalation_reason: { type: ['string', 'null'] },
    escalation_type: { type: 'string' },
    recommended_action: { type: ['string', 'null'] },
    target_role: { type: ['string', 'null'] },
    recommended_owner: { type: ['string', 'null'] },
    recommendation_status: { type: ['string', 'null'] },
    deadline_at: { type: ['string', 'null'], format: 'date-time' },
    next_step_due_at: { type: ['string', 'null'], format: 'date-time' },
    promise_overdue: { type: 'boolean' },
    sla_breached: { type: 'boolean' },
    evidence_summary: {
      type: 'object',
      properties: {
        competitor_mentions: { type: 'number' },
        debt_markers: { type: 'number' },
        subrent_markers: { type: 'number' },
        promise_markers: { type: 'number' },
      },
    },
    evidence_markers: {
      type: 'array',
      items: { type: 'string' },
    },
    state_codes: {
      type: 'array',
      items: { type: 'string' },
    },
    margin_percent: { type: ['number', 'null'] },
    debt_overdue_days: { type: ['number', 'null'] },
  },
};

export const logisticsQueueItemSchema = {
  type: 'object',
  properties: {
    opportunity_id: { type: 'string' },
    bitrix_deal_id: { type: ['string', 'null'] },
    company: { type: ['string', 'null'] },
    object: { type: ['string', 'null'] },
    equipment_type: { type: ['string', 'null'] },
    priority_score: { type: 'number' },
    urgency_bucket: { type: 'string' },
    own_equipment_available: { type: ['boolean', 'null'] },
    subrent_required: { type: ['boolean', 'null'] },
    recommended_action: { type: ['string', 'null'] },
    partner_hint: { type: ['string', 'null'] },
    demand_cluster_hint: { type: ['string', 'null'] },
    deadline_at: { type: ['string', 'null'], format: 'date-time' },
    state_codes: {
      type: 'array',
      items: { type: 'string' },
    },
  },
};

export const ownerDashboardItemSchema = {
  type: 'object',
  properties: {
    opportunity_id: { type: 'string' },
    company: { type: ['string', 'null'] },
    object: { type: ['string', 'null'] },
    priority_score: { type: 'number' },
    margin_percent: { type: ['number', 'null'] },
    own_equipment_available: { type: ['boolean', 'null'] },
    subrent_required: { type: ['boolean', 'null'] },
    debt_risk: { type: ['boolean', 'null'] },
    strategy_flag: { type: 'string' },
    owner_signal: { type: ['string', 'null'] },
    recommended_action: { type: ['string', 'null'] },
  },
};

export const ownerDashboardSchema = {
  type: 'object',
  properties: {
    summary: {
      type: 'object',
      properties: {
        total_opportunities: { type: 'number' },
        own_equipment_share: { type: 'number' },
        subrent_dependency_share: { type: 'number' },
        debt_exposure_share: { type: 'number' },
        average_margin_percent: { type: ['number', 'null'] },
        recommendation_accepted_rate: { type: 'number' },
        recommendation_executed_rate: { type: 'number' },
      },
    },
    items: {
      type: 'array',
      items: ownerDashboardItemSchema,
    },
  },
};

export const dataQualitySchema = {
  type: 'object',
  properties: {
    summary: {
      type: 'object',
      properties: {
        total_opportunities: { type: 'number' },
        linked_events_percent: { type: 'number' },
        normalized_objects_percent: { type: 'number' },
        opportunities_without_next_step: { type: 'number' },
        opportunities_missing_equipment: { type: 'number' },
        failed_ingest_events: { type: 'number' },
      },
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          opportunity_id: { type: 'string' },
          company: { type: ['string', 'null'] },
          object: { type: ['string', 'null'] },
          quality_score: { type: 'number' },
          issues: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    },
  },
};

export const feedbackLearningSchema = {
  type: 'object',
  properties: {
    summary: {
      type: 'object',
      properties: {
        total_feedback: { type: 'number' },
        accepted_rate: { type: 'number' },
        executed_rate: { type: 'number' },
        rejected_rate: { type: 'number' },
        recommendation_coverage: { type: 'number' },
      },
    },
    action_metrics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action_code: { type: ['string', 'null'] },
          total: { type: 'number' },
          accepted: { type: 'number' },
          executed: { type: 'number' },
          rejected: { type: 'number' },
          accepted_rate: { type: 'number' },
          executed_rate: { type: 'number' },
          rejected_rate: { type: 'number' },
        },
      },
    },
    rejection_reasons: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          reason: { type: ['string', 'null'] },
          total: { type: 'number' },
        },
      },
    },
    recent_feedback: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action_id: { type: ['string', 'null'] },
          action_code: { type: ['string', 'null'] },
          opportunity_id: { type: ['string', 'null'] },
          company: { type: ['string', 'null'] },
          status: { type: 'string' },
          recorded_at: { type: ['string', 'null'], format: 'date-time' },
        },
      },
    },
  },
};

export const graphViewSchema = {
  type: 'object',
  properties: {
    opportunity_id: { type: ['string', 'null'] },
    object_id: { type: ['string', 'null'] },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          type: { type: 'string' },
        },
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          target: { type: 'string' },
          type: { type: 'string' },
        },
      },
    },
  },
};

export function getContractsOverview() {
  return {
    bitrix_event: bitrixEventSchema,
    opportunity_unit: opportunityUnitSchema,
    recommendation_feedback: recommendationFeedbackSchema,
    manager_queue_item: managerQueueItemSchema,
    opportunity_card: opportunityCardSchema,
    rop_escalation_item: ropEscalationItemSchema,
    logistics_queue_item: logisticsQueueItemSchema,
    owner_dashboard_item: ownerDashboardItemSchema,
    owner_dashboard: ownerDashboardSchema,
    data_quality: dataQualitySchema,
    feedback_learning: feedbackLearningSchema,
    graph_view: graphViewSchema,
  };
}
