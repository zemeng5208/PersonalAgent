import {getGoal, listGoals} from '@personal-agent/goals/commands';
import {createGoalTools, GOAL_CREATE_TOOL, GOAL_REVISE_TOOL, GOAL_TOOL_VERSION} from '@personal-agent/goals/tool';
import {createGoalHostCore} from './goal-host-core.js';

export function createGoalHost(namespace) {
  return createGoalHostCore(namespace, {getGoal, listGoals, createGoalTools,
    GOAL_CREATE_TOOL, GOAL_REVISE_TOOL, GOAL_TOOL_VERSION});
}
