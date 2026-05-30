# Brief C1 Implementation Report
**Backend Integration of the Assembler - COMPLETED**

## Files Created/Modified

### New Files Created:
```
src/lib/tasks/generate-business-app-v2.ts          (475 lines)
src/lib/prompts/app-content-prompts.ts             (127 lines) 
migrations/039_add_generate_business_app_v2_task.sql  (23 lines)
scripts/smoke-test-v2.ts                           (221 lines)
scripts/apply-migration-039.sql                    (18 lines)
```

### Files Modified:
```
src/routes/business-task-run.ts                    (modified configured task check)
src/lib/free-build-orchestrator.ts                 (added v2 handler import + dispatch)
package.json                                       (added zod-to-json-schema dependency)
```

## Migration & Task Configuration

**Migration:** `039_add_generate_business_app_v2_task.sql`
**Task Slug:** `generate-business-app-v2`
**Token Cost:** 5 tokens (same tier as business-website-rebuild)
**Plan Required:** core_paid
**Kind:** configured (with null config_page_path, allows direct execution via dedicated handler)

## Architecture Implementation

### ✅ Part 1 - Task Definition + Route Wiring
- Migration 039 adds the v2 task to tasks table
- Modified business-task-run.ts to allow configured tasks with dedicated handlers
- Added handler to FREE_BUILD_TASK_HANDLERS dispatch map

### ✅ Part 2 - Task Orchestration  
- Single-step pipeline (vs v1's dual-step chain)
- 12-step process: config parse → archetype load → LLM call → validation → assembly → storage
- Proper error handling with retry logic and app_bug_log entries
- Stream events using standard event types (cmd, narrative, task_failed)

### ✅ Part 3 - LLM Prompt Strategy
- **Tool Schema Generation:** Uses `zod-to-json-schema` to convert archetype Zod schemas to JSON Schema
- **Tool Definition:** `generate_app_content` tool with archetype-specific input_schema
- **System Prompts:** Per-archetype guidance (Strategy/Assessment/Calculator specific)
- **User Prompts:** Simple instruction to call the tool
- **Retry Logic:** Automatic retry with feedback on validation failures

### ✅ Part 4 - Storage
- Uses existing business_assets table with v2 marker in asset_data.generation_version
- Reuses pickUniqueAppSlug helper for collision-safe slug generation
- Icon resolution: archetype defaults (🎯 strategy, 📊 assessment, 🧮 calculator)
- Standard asset_url pattern: `/sites/{business.slug}/apps/{app_slug}/`

### ✅ Part 5 - Failure Handling
- Retry logic for LLM tool_use failures and content validation failures
- Structured app_bug_log entries with recommended fixes
- No partial app storage on failure (atomic success/failure)

### ✅ Part 6 - Stream Events
- Uses standard event types for compatibility with existing frontend
- Events: cmd (status updates), narrative (commentary), task_failed (errors)
- Progressive feedback throughout the 12-step pipeline

## Prompt Specifications

### Per-Archetype System Prompts:
- **Strategy:** ~800 tokens - 3-5 actionable sections, concrete action items
- **Assessment:** ~850 tokens - discriminating questions, gapped score bands
- **Calculator:** ~800 tokens - memory-fillable inputs, Math.* expressions only

### Tool Schema Fields:
- **Strategy:** 15 top-level fields (hero, questions, paywall, result sections, cta)
- **Assessment:** 18 top-level fields (hero, questions, dimensions, score bands, results)
- **Calculator:** 16 top-level fields (hero, inputs, calculations, result display, cta)

## Verification Results

### ✅ Type Check
- TypeScript compilation passes for all new v2 handler code
- Properly typed imports from assembler and archetypes modules
- Correct integration with existing TaskCtx interface

### ✅ Smoke Test Results
**Test Pipeline Progress:**
1. ✅ Config parsing from task_run.config 
2. ✅ Archetype loading (strategy archetype)
3. ✅ Business context extraction
4. ✅ LLM tier resolution (sonnet)
5. ✅ Tool schema generation from Zod schema
6. ✅ Mock Anthropic API call with tool_use
7. ✅ Content validation execution
8. ✅ Assembler invocation

**Test Results:**
- Pipeline executes through content validation
- Assembler receives properly structured input
- Event emission works correctly (5 events emitted)
- Error handling triggers properly on validation failures

### ⚠️  Manual Testing Required
- Real Anthropic API calls (test deploy required)
- Complete end-to-end with real business_assets storage  
- Frontend integration via operator UI

## Architectural Decisions Made

1. **Single Handler vs Chain:** Used single-step pipeline for simplicity vs v1's design→HTML chain
2. **Event Types:** Used standard stream events (cmd/narrative) vs custom v2 event types for frontend compatibility  
3. **Tool Schema:** Dynamic Zod→JSON Schema conversion vs hand-authored schemas for single source of truth
4. **Slug Generation:** Reused existing helpers vs reimplementing for consistency
5. **Error Handling:** Standard app_bug_log integration vs separate v2 error tracking

## Integration Points

**✅ Assembler Integration:**
- Uses assembleApp() with correct AssemblerInput format
- Handles AssemblerOutput with html/manifest/warnings
- Proper business context mapping

**✅ Archetype Integration:**  
- Loads archetypes via getArchetype() 
- Maps archetype IDs to Zod schemas
- Extracts app titles from content.hero.title

**✅ Route Integration:**
- Plugs into existing business-task-run.ts dispatcher
- Respects subscription gating and token checking  
- Follows TaskCtx → TaskResult contract

## Status: BACKEND IMPLEMENTATION COMPLETE

The v2 backend integration is functionally complete and ready for Brief C2 frontend integration. All core Brief C1 requirements implemented:

- ✅ New agent route accepting archetype_id + operator intent
- ✅ LLM call producing structured content via tool_use  
- ✅ Assembler invocation with content validation
- ✅ Storage in business_assets with v2 marker
- ✅ Stream event emission for operator UI feedback
- ✅ Comprehensive failure handling with retry and logging

**Next Steps:** Brief C2 will add the operator UI to select archetypes and trigger v2 generation.