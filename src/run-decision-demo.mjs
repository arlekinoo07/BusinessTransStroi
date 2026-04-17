import { decideNextAction } from './dss/decision-engine.mjs';
import { opportunityStore } from './dss/sample-data.mjs';
import { evaluateOpportunityState } from './dss/state-engine.mjs';

for (const opportunity of opportunityStore.values()) {
  const state = evaluateOpportunityState(opportunity);
  const decision = decideNextAction(state);

  console.log(JSON.stringify({
    opportunity_id: opportunity.id,
    priority_score: state.priority_score,
    scores: state.scores,
    states: state.states.map((item) => item.state_code),
    decision: decision.recommended_action?.action_code ?? null,
    escalation: decision.escalation_action?.action_code ?? null,
  }, null, 2));
}
