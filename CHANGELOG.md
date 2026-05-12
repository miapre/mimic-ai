# Changelog

## 2.0.0 (unreleased)

Complete rewrite from scratch.

### Architecture
- Split MCP server (intelligence) / plugin (enforcement gate)
- Embedded bridge — no separate process to start
- Chart geometry computed in Node.js (not by LLM)
- Graduated DS enforcement — adapts to what the DS provides
- Phase enforcement — mechanical sequencing in MCP layer
- WebSocket keepalive + auto-reconnect

### Added
- Variable path validation — all `*Variable` params checked against DS cache before plugin; returns suggestions on mismatch
- Circuit breaker — 3 consecutive failures blocks build tools, forces report generation
- Build checkpoint — after 20 Phase 3 operations, prompts verification before continuing
- Build limit — 200 Phase 3 calls triggers forced stop
- `figma_set_all_variable_modes` — sets default mode on all collections at once (no collection name guessing)
- Plugin error surfacing — recovery hints and available options from plugin errors now visible to the LLM
- Component import timeout increased to 120s (was 60s) for cold library imports
- Fuzzy collection name matching in `set_variable_mode` (strips prefix numbers, case-insensitive)
- First build always succeeds on any DS configuration
- Chart calculation engine — deterministic bar/donut/line/radar/scatter/heatmap geometry
- Contextual tool responses — every tool returns hints, available values, recovery paths
- 7-step component configuration protocol with icon library detection
- DS gap tracking with savings estimates across builds
- Three-trigger learning model (correction → confirmation → auto-promote)
- ~20 focused source files (was 1 x 203KB monolith)
- 75 automated tests (was 31)

### 2.0.0-alpha.2 (2026-05-08)

#### Binding feedback system
- Every plugin create/edit handler now returns `{ applied, warnings, bindingFailures }` — the LLM sees exactly what DS bindings succeeded and which failed
- MCP tools surface `_bindingWarning` with specific failed binding names when plugin reports failures
- Session-level `bindingFailures[]` accumulates every failure for the build report
- Build report includes "Binding Failures" section with most-common failure patterns and recovery suggestions
- Batch handler propagates binding feedback from sub-handlers

#### Consolidated discovery
- `mimic_discover_ds` now performs all discovery in one call: variables → styles → components → preload → enforcement → Phase 2
- Returns `completenessWarnings` when discovery is partial
- Replaces the 5-step manual discovery sequence

#### Component variant properties
- `insert_component` now returns `variantProperties` with available values and current value for each property
- LLM can set correct variants (Icon, Hierarchy, Size, etc.) on first try — no guessing

#### Circuit breaker improvements
- Discovery, setup, and inspect tools exempt from circuit breaker (failures don't block builds)
- Discovery failures don't increment consecutive failure counter

#### Bug fixes
- `mimic_map_components`: `knowledgeStore` not destructured in ds-setup.js
- `figma_validate_ds_compliance`: MCP sent `validate` but plugin handler was `validate_ds_compliance`
- `inferCategory` exported from ds-setup.js for consolidated discovery

### Changed
- Hint text no longer says "retry" — always says "proceed with available, flag in report"
- 8 core rules in CLAUDE.md (was 60 golden rules)
- QA uses structural validation, not screenshots
- Artboard placement: rightmost + 80px (enforced)

### Removed
- `figma_create_chart` convenience tool (replaced by native chart building)
- Anti-bypass machinery (6 mechanisms removed)
- Session state flag sprawl (7 boolean flags → 1 phase counter)
- 45 band-aid rules that compensated for implementation bugs
