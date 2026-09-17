// The columns `enrichSite()` writes.
//
// Verifying a business through POST /api/admin/vetting/:id/status now probes
// its website and writes these, so ANY suite that verifies a real lead through
// the API mutates them — even though it never asked to and never mentions
// enrichment. Left out of a suite's TOUCHED list, they are never snapshotted
// and never restored, and the run leaves an enrichment result behind on
// somebody's real record. That is exactly the bug that once left
// LIC-CAMPAIGN-99 on a lead, in a different column.
//
// One list, imported everywhere, so the next column added to EnrichResult is a
// single edit rather than six suites to remember. Keep it in step with
// `EnrichResult` in src/lib/trustlight-enrich.ts — every key there except
// `note`, which is returned to the operator and is not a column.
//
// Suites that set vetting_status by writing the row directly do NOT need this:
// no endpoint ran, so nothing was enriched.
export const ENRICHMENT_COLUMNS = [
  "enrichment_status", "enriched_at",
  "site_state", "site_http_status", "has_website", "has_schema_org",
  "analytics_pixels", "chat_widget", "booking_tool", "call_tracking", "ai_voice_agent",
  "analytics_pixels_detail", "chat_widget_detail", "booking_tool_detail",
  "call_tracking_detail", "ai_voice_agent_detail",
  "platform", "domain", "domain_age_days", "domain_registered_on", "domain_registrar",
  "signal_confidence",
];
