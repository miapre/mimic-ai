<p align="center">
  <img src="assets/logo.svg" alt="Mimic AI" width="120">
</p>

# Mimic AI

**The design system copilot that builds Figma screens from HTML, and gets better every time you use it.**

Give Mimic any HTML. It builds the equivalent in Figma using your actual design system:

- Real components, not approximations
- Real tokens, not hardcoded values
- Real text styles, not manual overrides
- Auto-layout everywhere, not fixed frames

It doesn't just build once.
Every output improves the next, learning your system, your conventions, and your decisions over time.

After every build, it tells you what your design system is missing.

---

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js: v20.6+](https://img.shields.io/badge/node-%3E%3D20.6-brightgreen)
![Platform: macOS / Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)
[![Glama](https://glama.ai/mcp/servers/@miapre/mimic-ai/badge)](https://glama.ai/mcp/servers/@miapre/mimic-ai)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_MCP-0078d4?logo=visualstudiocode&logoColor=white)](vscode:mcp/install?%7B%22name%22%3A%22mimic-ai%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40miapre%2Fmimic-ai%22%5D%7D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_MCP-24bfa5?logo=visualstudiocode&logoColor=white)](vscode-insiders:mcp/install?%7B%22name%22%3A%22mimic-ai%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40miapre%2Fmimic-ai%22%5D%7D)

> Open-source MCP server. Runs locally. Your design data never leaves your machine.

---

<!-- TODO: GIF showing same HTML, different DS, different Figma output -->

---

## The problem

You built a design system. Every token, every component, every variable. Intentional.

Then someone needs a screen and builds it from scratch.

Your system sits in the library panel. Unused.

AI tools make it worse. They generate screens that look right but break on inspection: no components, no tokens, no structure.

The cleanup takes as long as building it yourself.

Mimic fixes that.

---

## It learns and compounds

The first build scans your design system.

By the third, patterns start to verify.
By the tenth, most decisions are instant.

Mimic doesn't just execute builds. It builds knowledge.

**Correct it once**
Tell Mimic:
"That's not the right Badge. Use Tag/Neutral."

That decision becomes permanent. Every future build uses it.

**Your design system evolves. Mimic keeps up.**
New components, renamed tokens, updated variants. Mimic detects changes at the start of every build and adapts automatically.

**Every build is a review**
After each build, Mimic tells you:
- What components were used
- What was built from primitives and why
- What patterns it learned
- What your design system is missing

Recommendations come as questions, backed by evidence:
"Should your design system include a Status Badge? Used 31 times as primitives."

---

## What changes after 10 builds

- You stop rebuilding screens by hand
- Your team uses the same component patterns automatically
- Design system gaps become visible, with evidence
- New team members produce consistent output from day one

Mimic becomes the system that remembers how your team builds.

---

## No HTML? Start from intent

Describe a screen:

> "Dashboard with metrics, activity table, and status overview"

Mimic builds it using your design system: components, tokens, and layout included.

Same system. Same rules. Same output quality.

---

## Make your design system AI-ready

Tools like Figma Make, Stitch, and generative UI depend on one thing:

Well-structured design systems.

Clear component roles. Consistent tokens. Meaningful descriptions.

Most design systems aren't there yet.

Mimic helps you get there as a side effect of using it.

**Component descriptions from usage**
Mimic observes how components are used across builds and suggests real descriptions based on actual patterns.

**DESIGN.md generation**
Generate a structured file describing your design system, readable by AI tools and frameworks.

Better structure leads to better output across every AI tool you use.

---

## What other tools get wrong

| | Other tools | Mimic |
|---|---|---|
| **Components** | Draws rectangles that look like buttons | Uses your real components |
| **Colors** | Hardcoded hex values | Bound to your variables |
| **Typography** | Manual font styling | Uses your text styles |
| **Spacing** | Raw pixel values | Uses your spacing tokens |
| **Layout** | Fixed frames | Auto-layout everywhere |
| **Learning** | Every build starts cold | Every build improves the next |
| **DS feedback** | None | Gap recommendations with evidence |
| **Output** | Needs cleanup | Ready to use |

Screenshot tools capture pixels.
Mimic captures structure.

---

## Works with any design system

| Design system type | What Mimic does |
|---|---|
| **Team library** (components + tokens) | Full usage: components, variables, text styles |
| **Team library** (components + typography variables) | Full usage: typography variables bound via setBoundVariable |
| **Team library** (components only) | Uses components, flags missing tokens, recommends adding them |
| **Community libraries** | Full support via REST API key discovery |

Enforcement adapts to what your DS provides. A library with text styles but no color variables enforces text styles and accepts raw colors. The build report shows what's missing and what adding it would unlock.

---

## Get started

> [Node.js](https://nodejs.org/) v20.6+, [Figma desktop](https://www.figma.com/downloads/), Professional plan or above.

### 1. Install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/miapre/mimic-ai/main/install.sh)
```

### 2. Add the Figma plugin

**Plugins > Development > Import plugin from manifest** > select `~/mimic-ai/plugin/manifest.json`

### 3. Connect (each session)

Figma: **Plugins > Development > Mimic AI > Run**

The bridge starts automatically when you make your first tool call. No separate process to manage.

### 4. Enable your design system

Assets panel > Team library icon > toggle on. Once per file. Community libraries work out of the box.

### 5. Build

> *"Build this HTML in Figma using my design system."*

One call discovers your entire DS (variables, styles, components), preloads everything, and advances to build-ready. No multi-step setup.

---

## What gets checked automatically

Every build enforces 13 quality rules across 6 sequential phases. You don't configure them. They just run.

- Text uses your text styles, not raw font properties
- Colors bound to your variables, not hardcoded
- Spacing bound to your tokens where available
- Every frame uses auto-layout, resizable, not static
- Content matches the source exactly, nothing invented
- Your components used wherever a match exists
- Variable paths validated with suggestions before reaching the plugin
- Binding feedback on every operation: you see exactly what succeeded
- Circuit breaker stops runaway builds after 3 consecutive failures
- Charts built with deterministic geometry and DS tokens
- Components fully configured: text overrides, semantic properties, icon slots
- Build report with learning summary, component usage %, and DS gap recommendations

The result is what you'd build manually, without the time cost.

Full specification: [`CLAUDE.md`](CLAUDE.md)

---

## MCP client setup

Works with any MCP client. Optimized for **Claude Code**.

<details>
<summary><strong>Claude Code</strong></summary>

```json
{
  "mcpServers": {
    "mimic-ai": {
      "command": "npx",
      "args": ["-y", "@miapre/mimic-ai"]
    }
  }
}
```

</details>

<details>
<summary><strong>Cursor</strong></summary>

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "mimic-ai": {
      "command": "npx",
      "args": ["-y", "@miapre/mimic-ai"]
    }
  }
}
```

</details>

<details>
<summary><strong>VS Code</strong></summary>

Click the install badge above, or add to settings:

```json
{
  "mcp": {
    "servers": {
      "mimic-ai": {
        "command": "npx",
        "args": ["-y", "@miapre/mimic-ai"]
        }
    }
  }
}
```

</details>

<details>
<summary><strong>Windsurf / JetBrains</strong></summary>

Windsurf: `~/.codeium/windsurf/mcp_config.json`
JetBrains: Settings > Tools > AI Assistant > MCP Servers

```json
{
  "mcpServers": {
    "mimic-ai": {
      "command": "npx",
      "args": ["-y", "@miapre/mimic-ai"]
    }
  }
}
```

</details>

All clients need the Figma plugin active. The bridge is embedded and starts automatically.

---

<details>
<summary><strong>How it works</strong></summary>

```
MCP Client (Claude Code, Cursor, VS Code)
    |
    | MCP Protocol (stdio)
    v
MCP Server (intelligence layer)
    - Tool registry, DS cache, knowledge store
    - Variable validation + suggestions before plugin
    - Circuit breaker (3 failures → stop + report)
    - Chart geometry engine (Node.js)
    - Phase enforcement (6 sequential phases)
    |
    | Embedded WebSocket bridge (auto-starts)
    v
Figma Plugin (enforcement gate)
    - DS enforcement: rejects raw values when DS has tokens
    - Binding feedback: reports which bindings succeeded/failed
    - Thin handlers: mechanical operations only
    |
    v
Figma Plugin API > Canvas
```

Intelligence flows down. Binding feedback flows up. The MCP layer validates variable paths before reaching the plugin. The plugin reports exactly which DS bindings succeeded and which failed. Tool responses carry contextual hints so the LLM always knows what to do next.

- **Building is unlimited.** Frames, components, and token bindings have no rate limit.
- **Inspecting is limited.** Reading your library uses Figma's daily quota. Mimic caches aggressively to stay well under.
- **Token bindings are real.** Update a variable in your DS, re-publish, and every node updates automatically.
- **Auto-layout everywhere.** Every frame resizes correctly. Nothing is manually positioned.

</details>

<details>
<summary><strong>53 tools available</strong></summary>

**Status and learning:** `mimic_status`, `mimic_discover_ds`, `mimic_ai_knowledge_read`, `mimic_ai_knowledge_write`, `mimic_generate_build_report`, `mimic_generate_design_md`

**DS setup:** `figma_preload_styles`, `figma_preload_variables`, `figma_discover_library_styles`, `figma_discover_library_variables`, `figma_discover_library_components`, `figma_set_session_defaults`, `figma_list_text_styles`, `figma_read_variable_values`, `mimic_map_components`

**Build:** `figma_create_frame`, `figma_create_text`, `figma_create_rectangle`, `figma_create_ellipse`, `figma_create_svg`, `figma_insert_component`, `figma_batch`

**Edit:** `figma_set_component_text`, `figma_set_component_text_by_id`, `figma_set_text`, `figma_set_text_style`, `figma_set_node_fill`, `figma_set_node_position`, `figma_set_layout_sizing`, `figma_set_variant`, `figma_set_visibility`, `figma_set_variable_mode`, `figma_set_all_variable_modes`, `figma_swap_main_component`, `figma_replace_component`, `figma_restyle_artboard`, `figma_move_node`, `figma_delete_node`

**Inspect and QA:** `figma_get_node_props`, `figma_get_node_children`, `figma_get_node_parent`, `figma_get_text_info`, `figma_get_component_variants`, `figma_get_selection`, `figma_select_node`, `figma_get_page_nodes`, `figma_get_pages`, `figma_change_page`, `figma_validate_ds_compliance`, `mimic_find_node`

**Rendering and charts:** `mimic_pipeline_resolve`, `mimic_render_url`, `mimic_compute_chart`

</details>

<details>
<summary><strong>Figma setup details</strong></summary>

**Desktop app required.** Browser Figma won't work. [Download](https://www.figma.com/downloads/)

**Personal Access Token.** Figma > Profile > Settings > Personal access tokens > Generate. Read access. Copy immediately.

**Publish your DS.** Components and tokens in a separate file, published as a team library. Re-publish after changes.

**Professional plan or above.** Free plan can't publish libraries.

</details>

---

## Cost and efficiency

Mimic gets cheaper over time.

| Build | Tool calls | Why |
|---|---|---|
| 1st (cold) | ~140 | Full DS discovery, no cache, every pattern new |
| 5th (warm) | ~80 | Most patterns cached, discovery skipped for known components |
| 10th+ (hot) | ~55 | Nearly everything cached, decisions instant |

**What drives cost down:**
- **Cache:** every pattern Mimic learns skips a DS search next time
- **DS components:** inserting a component = ~3 calls. Building the same thing from primitives = ~10-15 calls
- **Recipes:** full component configurations replayed from cache, no re-inspection needed
- **DS gap recommendations:** when Mimic suggests a component, it's also telling you how to make future builds cheaper

Every build report includes tool call counts and efficiency savings.

---

## Privacy

Everything runs locally.

No design data leaves your machine.
No telemetry.
No tracking.

The only outbound call is to the Figma REST API for published component keys.

---

## Constraints

- **Figma Professional plan required.** Free plan can't publish libraries.
- **First-build font caching.** Non-Inter DS fonts may fail on the first text node. Retry succeeds.
- **npx mode.** Doesn't set `FIGMA_ACCESS_TOKEN`. Use the full installer for team library support.
- **Graduated DS enforcement.** Adapts to what your DS provides. A component-only library gets components; raw values fill the gaps. The report shows what to add.
- **Claude-optimized.** The 6-phase protocol and contextual tool hints work best with Claude Code. Other MCP clients get the tools but may not follow the full protocol.

---

## License

MIT
