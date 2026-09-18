export {analyzeImpact, proposePlanRevision, CognitionError} from './impact.js';
export type {ImpactCause, ImpactItem, ImpactReport, PlanRevisionRequest, PlanRevisionProposal} from './impact.js';
export {analyzeStoredImpact, commitStoredPlanRevision} from './persistent.js';
export type {StoredImpact, StoredPlanRevisionRequest, StoredPlanRevisionResult,
  AppliedPlanRevision, ConflictedPlanRevision} from './persistent.js';
export {previewFactProjection, FactProjectionError} from './fact-projection.js';
