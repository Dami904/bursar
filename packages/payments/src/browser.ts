/**
 * The browser-safe part of @bursar/payments: contract ABIs, id derivation and the approval
 * message. No Node APIs and no Circle SDK, so the console can import it.
 */
export * from "./chain.js";
export * from "./approval.js";
