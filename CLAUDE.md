# Mimic AI

MCP tool that translates HTML into Figma using the DS present
on the user's target file. Learns from every build.

## Build Protocol

Every build follows 6 phases in order:
0. Target → 1. DS Discovery → 2. Style Inventory →
3. Build → 4. QA → 5. Report

Call `mimic_status` to start. It returns the current state
and what to do next.

## Core Rules

1. Components first. If the DS has it, use it — even if the
   layout doesn't match exactly. Intent over pixel-matching.
2. Text and color are non-negotiable. Every text node: DS text
   style + DS color variable. Every fill: DS color variable.
   No exceptions.
3. Spacing/radius: bind to DS variables when available, raw
   values acceptable if DS lacks them.
4. Auto-layout everywhere. FILL widths, HUG heights.
   Fixed width only on the artboard (1440px).
5. After inserting any component: override ALL text, set
   semantic properties, configure icons, hide unused slots.
   No placeholder content ever.
6. HTML is the source of truth for content. Same text, same
   structure, same order. Don't invent or improve.
7. Feedback means iterate the existing artboard.
   Never delete artboards.
8. Every build ends with a report. Not optional.
9. Name every node after its HTML role. "Header Section" not
   "Frame". "Card: Total Users" not "Frame". This enables
   iteration — finding nodes by name instead of traversing.

## Tool Guidance

Each tool response includes contextual hints:
- Available DS variables for the current property
- Component recipes from the knowledge store
- Warnings when something looks wrong
- Next steps when an error occurs

Follow the tool responses. They know the DS state.
