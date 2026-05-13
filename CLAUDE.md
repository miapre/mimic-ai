# Mimic AI

MCP tool that translates HTML into Figma using the DS present
on the user's target file. Learns from every build.

## Prerequisites

- **Figma plugin must be running.** In Figma desktop:
  Plugins > Development > Mimic AI > Run. The bridge
  connects automatically on first tool call.
- **fileKey** is the alphanumeric string in the Figma URL:
  `figma.com/design/<fileKey>/...` — pass it to
  `mimic_discover_ds`.
- **Start every build with `mimic_status`.** It returns the
  current phase and tells you what to do next.
- **Don't guess variable paths.** Discovery populates the
  cache. Use `figma_read_variable_values` or
  `figma_list_text_styles` to see what's available.

## Component-First Principle

**Target ~90% DS component usage, ~10% primitives with DS
variables.** Every build should maximize DS component coverage.
Before creating ANY frame, check if the DS has a component for
it. Section-level elements (header, footer, sidebar) and UI
patterns (cards, metrics, tables, badges, buttons, inputs)
should ALWAYS be DS components. Only use `figma_create_frame`
for truly custom layouts that have no DS equivalent — and even
then, bind every property to DS variables and text styles.

After `mimic_discover_ds`, ALWAYS call `mimic_map_components`
with all section-level elements in the design. For any missing
components, search the library via Figma MCP
`search_design_system` before building custom frames.

## Build Protocol

Every build follows 6 phases in order:
0. Target → 1. DS Discovery → 2. Style Inventory →
3. Build → 4. QA → 5. Report

Call `mimic_status` to start. It returns the current state
and what to do next.

## Phase 1+2 — DS Discovery (TWO CALLS)

Discovery is a two-step process that ensures community
libraries are never missed:

**Step 1 — Plugin discovery:**
```
mimic_discover_ds(fileKey)
```
Discovers variables, text styles, and components via the
Figma plugin API. Caches everything and computes enforcement
profile. Stays at Phase 1 (NOT build-ready yet).

The response includes `communityLibraryCheckRequired: true`
and `_stopBuild: true`. Build tools are blocked at Phase 1.

If multiple DS libraries are detected by the plugin, discovery
STOPS with `_userPrompt`. Present the prompt to the user
EXACTLY as written, wait for their pick, then re-call with
`libraryKey`.

**Step 2 — Community library check:**
Call Figma MCP `search_design_system` with query `"color"`,
`includeVariables: true, includeComponents: false,
includeStyles: false` on the fileKey. Collect all unique
non-null `libraryName` values from the results. Then:
```
mimic_discover_ds(fileKey, {
  communitySearchResults: ["LibraryA", "LibraryB", ...]
})
```
The tool compares search results against plugin-detected
libraries. If new libraries are found, it returns a
`_userPrompt` with a lettered list. If no new libraries,
it advances to Phase 2 (build-ready).

This check is **enforced by the tool** — build tools require
Phase 2, which only unlocks after community verification.

Check `completenessWarnings` in the response. If components
were not found on the page, use Figma MCP
`search_design_system` to find them by name.

After discovery, call `mimic_map_components` with the HTML
element types to get the exact component keys for the build.

The individual tools (`figma_discover_library_styles`,
`figma_discover_library_variables`, etc.) still exist for
manual use if needed, but `mimic_discover_ds` replaces the
5-step sequence.

## Core Rules

1. Components first. If the DS has it, use it — even if the
   layout doesn't match exactly. Intent over pixel-matching.
2. Mandatory components: Buttons, Badges, Input fields, Table
   cells, Table header cells, Tabs, Dropdowns, Textareas, and
   Avatars MUST always use DS components. Never build these as
   primitives. If import fails with a non-font error, STOP —
   do not substitute. Font errors are handled automatically
   (see "Font-Incompatible Libraries" below).
3. Text and color are non-negotiable. Every text node: DS text
   style (textStyleId) + DS color variable (fillVariable).
   No exceptions. Use fontSizeVariable ONLY if no text style
   exists for the size.
4. Spacing/radius: bind to DS variables when available, raw
   values acceptable if DS lacks them.
5. Auto-layout everywhere. FILL widths, HUG heights.
   Fixed width only on the artboard (1440px).
6. Cards in a horizontal row: layoutSizingVertical = FILL so
   they match height. Never HUG on cards in a row.
7. After inserting any component — read `configurationChecklist`
   in the response. It tells you EXACTLY what to do. The steps
   are always:
   a. Read `configurationChecklist` — it has
      ENABLE_BOOLEANS_IF_NEEDED, OVERRIDE_ALL_TEXT, and
      SET_VARIANTS actions. Do ALL of them.
   b. **Booleans are auto-disabled at insertion time.** The
      plugin turns OFF all boolean properties (hint text,
      help icons, trailing icons, asterisks, etc.) when a
      component is inserted. You only need to RE-ENABLE
      booleans that the source HTML explicitly shows. If the
      HTML has no icons, no hint text, no asterisks — do
      nothing. The component is already clean.
   c. Set the correct variant properties via
      `figma_set_variant`. Always check what the current
      values are and change any that don't match the HTML.
   d. Override ALL text via `figma_set_component_text`. Use
      the `textNodes` list — every node listed must get real
      content from the HTML. No placeholder text ever.
   e. Set layoutSizingHorizontal to FILL when the component
      should stretch to fill its container.
   CRITICAL: If `disabledBooleans` is empty in the response,
   auto-disable did not run — manually disable all booleans
   the HTML doesn't show.
8. Dividers and separators: search for a DS component first
   (e.g. "Content divider"). Never use raw rectangles for
   visual separators. After inserting, check variantProperties
   for the right type, override any text, and set FILL width.
9. HTML is the source of truth for content. Same text, same
   structure, same order. Don't invent or improve.
10. Feedback means iterate the existing artboard.
    Never delete artboards.
11. Every build MUST end with `mimic_generate_build_report`.
    This is NOT optional — it is the tool's key differentiator.
    The report teaches users about DS usage, gaps, patterns,
    and efficiency. A build without a report is incomplete.
    Call it BEFORE responding to the user with build results.
12. Name every node after its HTML role. "Header Section" not
    "Frame". "Card: Total Users" not "Frame". This enables
    iteration — finding nodes by name instead of traversing.
13. Section-level elements (header, footer, sidebar) MUST use
    DS components if they exist. `figma_discover_library_components`
    only scans page instances — if no match is found, you MUST
    search the library via Figma MCP `search_design_system` before
    building a custom section. Never build a custom footer/header
    without first confirming the DS has no component for it.
14. Section-level DS components are NON-NEGOTIABLE. When
    `mimic_map_components` returns a component for header, footer,
    or sidebar — use it. The HTML layout is irrelevant. The DS
    component IS the authoritative layout. Override text content
    to match the HTML, but NEVER build a custom section-level
    frame when a DS component was found. No rationalizing
    ("layout doesn't match", "too different from HTML"). Intent
    over pixel-matching — always.
15. INSERT_TIMEOUT recovery. When `figma_insert_component`
    returns INSERT_TIMEOUT, the component MAY have been created.
    Before doing anything else: wait 3 seconds, then call
    `figma_get_node_children` on the parent. If the component
    appears — do NOT retry, proceed with configuration. If it
    doesn't appear, check once more after 3 seconds. Only retry
    the insert if the component is confirmed absent after both
    checks. NEVER retry without checking — duplicates are hard
    to detect and fix.
16. Build report presentation. After calling
    `mimic_generate_build_report`, ALWAYS present a formatted
    summary to the user. Include: DS component instances table,
    primitives with justifications, binding quality, efficiency
    stats (tool calls, cache hits), and DS gap recommendations.
    The report file is for persistence — the user must SEE the
    full results in the conversation. A build without a visible
    report is incomplete.

## Font-Incompatible Libraries

When `figma_insert_component` returns `LIBRARY_FONT_INCOMPATIBLE`,
the selected library's components require fonts not loaded in the
file. The tool automatically:

1. Sets `libraryFontIncompatible: true` on the session.
2. Auto-bypasses the component-first gate — `figma_create_frame`
   with names like "Button: X" or "Footer Section" will pass
   without `confirmedNoComponent` / `primitiveOverrideReason`.
3. Returns a structured error (not a throw) so you can continue.

**When this happens:** proceed with primitives + DS variables
for all elements. Do NOT retry other components from the same
library — they will all fail for the same font reason.

## Variable Source Mismatch

Discovery caches variables from whatever libraries are **enabled
in the file**, not from the selected library. If the selected
library has no variables in the file, `completenessWarnings`
will include a `VARIABLE SOURCE MISMATCH` warning listing which
libraries actually provide the tokens.

This means components come from one library, but colors/spacing/
radius bindings come from another. This is expected when using
a component-only library (e.g. Material UI) on a file that has
a separate token library (e.g. Untitled UI, LayerLens Theme).

## Safety Guardrails

- **Binding feedback**: Every create/edit tool returns
  `applied` (what DS bindings succeeded) and `warnings`
  (what failed). If `bindingFailures: true`, the node has
  missing DS bindings. Check `_bindingWarning` for specifics.
  DO NOT continue building if bindings are failing — fix the
  variable paths first using `figma_read_variable_values`.
- **Variable validation**: All `*Variable` params are checked
  against the DS cache before reaching the plugin. Wrong paths
  return suggestions, not silent failures.
- **Circuit breaker**: 3 consecutive failures → all build tools
  blocked until you generate the report. Status/QA/report tools
  remain available.
- **Build checkpoint**: After 20 build operations in Phase 3,
  a checkpoint message prompts you to verify progress before
  continuing.
- **Build limit**: 300 tool calls in Phase 3 → forced stop.
  Generate the report and assess.

## Artboard Setup

1. Create the artboard with x/y position. Query page nodes
   first, place at rightmost artboard x + width + 80px.
2. Call `figma_set_all_variable_modes` with the artboard
   nodeId. This sets default modes on ALL variable collections
   (including library collections). Without it, DS variables
   render as black.
3. Use modeIndex=0 for light, modeIndex=1 for dark.

## Tool Guidance

Each tool response includes:
- `applied`: Which DS bindings succeeded (true/false per binding)
- `warnings`: What failed and why (variable not found, style not importable)
- `bindingFailures`: true if ANY binding failed — treat as a red flag
- `_bindingWarning`: Human-readable summary of what went wrong
- `hint`: Next step guidance

**If you see `bindingFailures: true` — STOP and fix before continuing.**
The most common cause is wrong variable paths. Call
`figma_read_variable_values` to see the actual cached paths.

## Chart Computation

Use `mimic_compute_chart` for all chart geometry. NEVER hand-write
SVG arc paths, trig, or coordinate math — the tool does it all.

Supported types: bar, donut, line, radar, scatter, heatmap.

Every chart response includes `_chartBuildRules` and
`_chartColorHint` with the full mandatory build workflow.
**Follow the rules in the tool response** — they cover native
vs. SVG approach, anti-patterns, and DS color bindings.

Key principles (details in tool response):
- Prefer native Figma primitives (frames + rectangles) over SVGs
- NEVER use `stroke` in SVGs — Figma renders them as thick blobs
- NEVER put `<text>` in SVGs — use native Figma text nodes
- NEVER use `●` in text for chart legends — use colored rectangles
- Bind ALL vector children to DS variables after creation
