/** The AI operator as a library: the worker runs it automatically when a job goes live. */
export { bursarClient, BursarError, type Bursar } from "./bursar.js";
export { runOperator, type OperatorOptions, type OperatorResult } from "./operator.js";
export type { ModelProvider } from "./model.js";
export { hasModelKey, providerFromEnv } from "./providers/index.js";
