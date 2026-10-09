'use strict';

/**
 * mimic_build_table — Bulk table builder.
 *
 * Creates an entire column-based table in one tool call:
 * column frames, header cells, data cells, all configured
 * with correct variants, text, and sizing.
 *
 * Reduces a 10×5 table from ~210 tool calls to 1.
 */

// ── Sequential execution ──
// Uses SequentialSender instead of BatchCollector. BatchCollector's
// batch_execute causes plugin timeouts on large libraries (5000+
// components) because the entire batch is processed in a single
// WebSocket round-trip. SequentialSender sends each operation
// individually, avoiding the accumulated timeout pressure.
const { SequentialSender } = require('../utils/batch-collector');

// ── DS-agnostic cell resolution ────────────────────────────────────────────
// The bulk builder must not assume Untitled-UI conventions (a variant property
// literally named "Style", a text node literally named "Text"). Different DS
// Table-cell components name these differently, and the cell's text nodes
// change with its variant. These helpers read the component's real variant
// schema (from the insert response) and the cell's real text nodes (after the
// variant is applied) so content lands in the right place. They degrade to the
// legacy names when no schema/children data is available (keeps older DS and
// unit mocks working).

// insert_component responses carry textNodes/variantProperties either at the
// top level (raw plugin) or under configurationHints (MCP-wrapped). Read both.
function pickField(result, field) {
  if (!result) return undefined;
  if (result[field] !== undefined) return result[field];
  if (result.configurationHints && result.configurationHints[field] !== undefined) return result.configurationHints[field];
  return undefined;
}
function insertTextNodes(result) {
  const t = pickField(result, 'textNodes');
  return Array.isArray(t) ? t.map(n => ({ id: n.nodeId || n.id, name: n.name })) : [];
}
function insertVariantProps(result) {
  const v = pickField(result, 'variantProperties');
  return (v && typeof v === 'object') ? v : {};
}
// Find the variant property + exact-cased value that owns a requested style
// (case-insensitive), scanning ALL variant properties — don't assume "Style".
function resolveStyleVariant(variantProps, requested) {
  if (!requested || !variantProps) return null;
  const want = String(requested).trim().toLowerCase();
  for (const prop of Object.keys(variantProps)) {
    const meta = variantProps[prop];
    const values = (meta && Array.isArray(meta.values)) ? meta.values : [];
    for (const v of values) {
      if (String(v).trim().toLowerCase() === want) return { prop, value: v };
    }
  }
  return null;
}
function findPropName(variantProps, re) {
  if (!variantProps) return null;
  return Object.keys(variantProps).find(p => re.test(p)) || null;
}
// Collect visible TEXT nodes in document order from a get_node_children tree.
function collectTextNodes(children, out) {
  if (!Array.isArray(children)) return out;
  for (const c of children) {
    if (c.type === 'TEXT' && c.visible !== false) out.push({ id: c.id, name: c.name });
    if (Array.isArray(c.children)) collectTextNodes(c.children, out);
  }
  return out;
}
async function readVisibleTextNodes(bridge, nodeId) {
  try {
    const res = await bridge.send('get_node_children', { nodeId, depth: 6 });
    return collectTextNodes(res && res.children, []);
  } catch { return []; }
}

function register(server, context) {
  const { bridge, dsCache, session, requirePhase, advancePhase, registerTool, knowledgeStore } = context;

  registerTool(
    'mimic_build_table',
    'Bulk table builder — creates an entire data table in ONE call: column frames, DS Table header cell + Table cell components, variants (cellVariants for per-value badge colors), text, and consistent row height. Use for ANY HTML data table instead of cell-by-cell insertion; reduces 200+ tool calls to 1. Requires table cell components in the DS (returns creation guidance if missing). Key params: parentId, columns (header/style/cellVariants), rows ("text|supporting" syntax), cellHeight. Phase 2+.',
    {
      type: 'object',
      properties: {
        parentId: {
          type: 'string',
          description: 'Parent node ID to insert the table body into.',
        },
        columns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              header: { type: 'string', description: 'Column header text (e.g. "Name", "Status").' },
              style: {
                type: 'string',
                description: 'Table cell variant Style for this column. Common values: "Text", "Lead text", "Lead avatar", "Badge", "Link". Check available styles from mimic_map_components or figma_insert_component response.',
              },
              supportingText: {
                type: 'boolean',
                description: 'Whether cells in this column show supporting text (second line). Default false.',
              },
              cellVariants: {
                type: 'object',
                description: 'Maps cell text values to variant overrides. Applied AFTER the column Style variant. Example for badge colors: {"Active": {"Color": "Success"}, "Pending": {"Color": "Warning"}, "Inactive": {"Color": "Gray"}}. Nested components (e.g. Badge inside Table cell) inherit variant changes.',
                additionalProperties: {
                  type: 'object',
                  description: 'Variant property key-value pairs to apply when cell text matches the key.',
                },
              },
            },
            required: ['header', 'style'],
          },
          description: 'Column definitions. Each column becomes a vertical frame with a header cell + data cells.',
        },
        rows: {
          type: 'array',
          items: {
            type: 'array',
            items: { type: 'string' },
          },
          description: 'Row data as arrays of strings. Each inner array has one value per column. Use "|" to separate text and supporting text (e.g. "Sarah Chen|sarah@company.com"). Array length must match columns length.',
        },
        headerCellKey: {
          type: 'string',
          description: 'Component key for Table header cell. If omitted, auto-resolved from DS cache/knowledge store.',
        },
        dataCellKey: {
          type: 'string',
          description: 'Component key for Table cell. If omitted, auto-resolved from DS cache/knowledge store.',
        },
        cellHeight: {
          type: 'number',
          description: 'Fixed height for ALL data cells in pixels. Ensures row alignment across columns. Common values: 44, 56, 64, 72. If omitted, cells use HUG (may cause misalignment).',
        },
        headerVariant: {
          type: 'object',
          description: 'Variant overrides for all header cells (e.g. {"Checkbox": "False"}). Applied to every header.',
        },
        firstColumnPaddingLeft: {
          type: 'string',
          description: 'DS spacing variable path for extra left padding on header cells and data cells of the FIRST column. Use when the table is inside a card to create visual inset (e.g., 24px/spacing-3xl). Applied via paddingLeftVariable on cells.',
        },
        lastColumnPaddingRight: {
          type: 'string',
          description: 'DS spacing variable path for extra right padding on header cells and data cells of the LAST column. Use when the table is inside a card to create visual inset (e.g., 24px/spacing-3xl). Applied via paddingRightVariable on cells.',
        },
      },
      required: ['parentId', 'columns', 'rows'],
    },
    async (args) => {
      requirePhase(2, 'Complete DS Discovery first.');

      const { parentId, columns, rows, cellHeight, headerVariant, firstColumnPaddingLeft, lastColumnPaddingRight } = args;

      // ── Validate input ──
      if (!columns || columns.length === 0) {
        return { error: 'NO_COLUMNS', message: 'At least one column is required.' };
      }
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].length !== columns.length) {
          return {
            error: 'ROW_COLUMN_MISMATCH',
            message: `Row ${i} has ${rows[i].length} values but ${columns.length} columns are defined.`,
          };
        }
      }

      // ── Resolve component keys ──
      let headerCellKey = args.headerCellKey || null;
      let dataCellKey = args.dataCellKey || null;

      // Auto-resolve from knowledge store + DS cache
      if (!headerCellKey || !dataCellKey) {
        const { DsDiscovery } = require('../ds/discovery');
        const discovery = new DsDiscovery(bridge, dsCache, knowledgeStore);
        if (session.selectedLibraryKey) discovery.setLibrary(session.selectedLibraryKey);

        if (!headerCellKey) {
          const result = discovery.searchComponent('table header cell');
          if (result.found) headerCellKey = result.componentKey;
        }
        if (!dataCellKey) {
          const result = discovery.searchComponent('table cell');
          if (result.found) dataCellKey = result.componentKey;
        }
      }

      // ── Missing components guidance ──
      if (!headerCellKey || !dataCellKey) {
        const missing = [];
        if (!headerCellKey) missing.push('Table header cell');
        if (!dataCellKey) missing.push('Table cell');

        return {
          error: 'TABLE_COMPONENTS_MISSING',
          missingComponents: missing,
          message: `Your DS doesn't have ${missing.join(' and ')} component(s). The bulk table builder requires cell-level components with variant styles (Text, Badge, Lead avatar, etc.).`,
          recommendation: [
            'Create these components in your DS library:',
            '',
            '• Table header cell — a component set with variants:',
            '  - Text (boolean): shows/hides the column name',
            '  - Checkbox (boolean): shows/hides a row selector',
            '',
            '• Table cell — a component set with variants:',
            '  - Style: Text, Lead text, Lead avatar, Badge, Link, etc.',
            '  - Supporting text (boolean): shows/hides a second line',
            '',
            'After creating and publishing these components, re-run mimic_discover_ds.',
          ].join('\n'),
          fallbackHint: 'You can still build tables manually with figma_create_frame + figma_create_text, but cell-level components give you variant-based styling and consistent density.',
        };
      }

      // ── Resolve import modes ──
      const headerMeta = dsCache.getComponent(headerCellKey);
      const dataMeta = dsCache.getComponent(dataCellKey);
      const headerImportMode = headerMeta?.isComponentSet ? 'componentSet' : 'component';
      const dataImportMode = dataMeta?.isComponentSet ? 'componentSet' : 'component';

      // ── Build the table ──
      const results = {
        columns: [],
        headerCells: 0,
        dataCells: 0,
        totalOperations: 0,
        failures: [],
      };

      // Sequential sender — each op sent individually to avoid plugin timeouts
      const collector = new SequentialSender(bridge);

      // Create the table body frame (horizontal, contains columns)
      let tableBodyId;
      try {
        const bodyResult = await collector.send('create_frame', {
          parentId,
          name: 'Table Body',
          direction: 'HORIZONTAL',
          layoutSizingHorizontal: 'FILL',
          layoutSizingVertical: 'HUG',
        });
        tableBodyId = bodyResult?.nodeId;
        results.totalOperations++;
      } catch (err) {
        return { error: 'TABLE_BODY_FAILED', message: err.message };
      }

      // Deferred cellVariant operations (need real nodeIds — processed after flush)
      const pendingCellVariants = [];

      // Build each column
      for (let colIdx = 0; colIdx < columns.length; colIdx++) {
        const col = columns[colIdx];
        const colName = `Column: ${col.header}`;

        // Create column frame
        let colId;
        try {
          const colResult = await collector.send('create_frame', {
            parentId: tableBodyId,
            name: colName,
            direction: 'VERTICAL',
            layoutSizingHorizontal: 'FILL',
            layoutSizingVertical: 'HUG',
          });
          colId = colResult?.nodeId;
          results.totalOperations++;
        } catch (err) {
          results.failures.push({ column: col.header, error: err.message });
          continue;
        }

        // Insert header cell
        try {
          const headerResult = await collector.send('insert_component', {
            componentKey: headerCellKey,
            parentId: colId,
            name: `TH: ${col.header}`,
            importMode: headerImportMode,
          });
          results.totalOperations++;

          if (headerResult?.nodeId) {
            // Configure header: set text, disable checkbox, FILL width
            const headerOps = [];

            // Set header text — use the header cell's real primary text node
            // name (not a hardcoded "Text"); fall back to "Text" when unknown.
            const headerTextName = (insertTextNodes(headerResult)[0] || {}).name || 'Text';
            headerOps.push(collector.send('set_component_text', {
              nodeId: headerResult.nodeId,
              textNodeName: headerTextName,
              content: col.header,
            }));

            // Set header variants (checkbox off by default)
            const hVariant = { Checkbox: 'False', ...(headerVariant || {}) };
            headerOps.push(collector.send('set_variant', {
              nodeId: headerResult.nodeId,
              properties: hVariant,
            }));

            // FILL width
            headerOps.push(collector.send('set_layout_sizing', {
              nodeId: headerResult.nodeId,
              layoutSizingHorizontal: 'FILL',
            }));

            // Apply first/last column padding to header cells
            if (colIdx === 0 && firstColumnPaddingLeft) {
              headerOps.push(bridge.send('set_node_props', {
                nodeId: headerResult.nodeId,
                paddingLeftVariable: firstColumnPaddingLeft,
              }).catch(() => {}));
            }
            if (colIdx === columns.length - 1 && lastColumnPaddingRight) {
              headerOps.push(bridge.send('set_node_props', {
                nodeId: headerResult.nodeId,
                paddingRightVariable: lastColumnPaddingRight,
              }).catch(() => {}));
            }

            await Promise.all(headerOps);
            results.totalOperations += 3;
            results.headerCells++;
          }
        } catch (err) {
          results.failures.push({ column: col.header, phase: 'header', error: err.message });
        }

        // Insert data cells for each row
        for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
          const cellValue = rows[rowIdx][colIdx];
          const parts = cellValue.split('|');
          const text = parts[0].trim();
          const supportingText = parts.length > 1 ? parts[1].trim() : null;
          const hasSupportingText = col.supportingText && supportingText;

          try {
            const cellResult = await collector.send('insert_component', {
              componentKey: dataCellKey,
              parentId: colId,
              name: `TD: ${text}`,
              importMode: dataImportMode,
            });
            results.totalOperations++;

            if (cellResult?.nodeId) {
              const vprops = insertVariantProps(cellResult);
              const hasSchema = Object.keys(vprops).length > 0;

              // Supporting-text variant — discover the real property name
              // (don't assume "Supporting text"); legacy fallback when no schema.
              const supProp = findPropName(vprops, /supporting[\s-]*text/i) || (hasSchema ? null : 'Supporting text');
              if (supProp) {
                try {
                  await collector.send('set_variant', {
                    nodeId: cellResult.nodeId,
                    properties: { [supProp]: hasSupportingText ? 'True' : 'False' },
                  });
                  results.totalOperations++;
                } catch { /* supporting-text property not settable here */ }
              }

              // Style variant — find WHICH variant property owns the requested
              // style value instead of assuming a property named "Style".
              const styleMatch = resolveStyleVariant(vprops, col.style);
              if (styleMatch) {
                try {
                  await collector.send('set_variant', {
                    nodeId: cellResult.nodeId,
                    properties: { [styleMatch.prop]: styleMatch.value },
                  });
                  results.totalOperations++;
                } catch (styleErr) {
                  results.failures.push({ column: col.header, row: rowIdx, phase: 'style', error: styleErr.message });
                }
              } else if (!hasSchema) {
                // Legacy fallback: no variant schema available (older DS / mocks).
                try {
                  await collector.send('set_variant', { nodeId: cellResult.nodeId, properties: { Style: col.style } });
                  results.totalOperations++;
                } catch { /* ignore */ }
              } else {
                const available = Object.keys(vprops)
                  .map(p => `${p}: [${((vprops[p] && vprops[p].values) || []).join(', ')}]`).join('; ');
                results.failures.push({
                  column: col.header, row: rowIdx, phase: 'style',
                  error: `Style "${col.style}" is not a valid variant value for this DS's Table cell (available — ${available}). Cell left at default; text still applied to its primary text node.`,
                });
              }

              // Resolve the cell's REAL text nodes AFTER the variant is applied
              // (the variant can swap the inner content), then set content by
              // the actual node name — never a hardcoded "Text".
              let cellTextNodes = await readVisibleTextNodes(bridge, cellResult.nodeId);
              if (cellTextNodes.length === 0) cellTextNodes = insertTextNodes(cellResult);
              const primary = cellTextNodes[0];
              if (primary && primary.name) {
                try {
                  await collector.send('set_component_text', {
                    nodeId: cellResult.nodeId, textNodeName: primary.name, content: text,
                  });
                  results.totalOperations++;
                } catch (textErr) {
                  results.failures.push({ column: col.header, row: rowIdx, phase: 'text', error: textErr.message });
                }
              } else {
                results.failures.push({ column: col.header, row: rowIdx, phase: 'text', error: 'No text node found in cell after variant configuration.' });
              }

              // Supporting text → the second text node, if present.
              if (hasSupportingText && cellTextNodes[1] && cellTextNodes[1].name) {
                try {
                  await collector.send('set_component_text', {
                    nodeId: cellResult.nodeId, textNodeName: cellTextNodes[1].name, content: supportingText,
                  });
                  results.totalOperations++;
                } catch { /* supporting text node not settable */ }
              }

              // Defer cellVariants — need real nodeIds from get_node_children.
              // Collected here, processed after collector flush (Phase 2).
              if (col.cellVariants && col.cellVariants[text]) {
                pendingCellVariants.push({
                  cellRef: cellResult.nodeId, // $resultOf:N — resolved after flush
                  variantProps: col.cellVariants[text],
                });
              }

              // Set FILL width + fixed height for row alignment
              const sizingPayload = {
                nodeId: cellResult.nodeId,
                layoutSizingHorizontal: 'FILL',
              };
              if (cellHeight) {
                sizingPayload.layoutSizingVertical = 'FIXED';
                sizingPayload.height = cellHeight;
              }
              try {
                await collector.send('set_layout_sizing', sizingPayload);
                results.totalOperations++;
              } catch { /* non-fatal */ }

              // Apply first/last column padding to data cells
              if (colIdx === 0 && firstColumnPaddingLeft) {
                try {
                  await bridge.send('set_node_props', {
                    nodeId: cellResult.nodeId,
                    paddingLeftVariable: firstColumnPaddingLeft,
                  });
                  results.totalOperations++;
                } catch { /* non-fatal */ }
              }
              if (colIdx === columns.length - 1 && lastColumnPaddingRight) {
                try {
                  await bridge.send('set_node_props', {
                    nodeId: cellResult.nodeId,
                    paddingRightVariable: lastColumnPaddingRight,
                  });
                  results.totalOperations++;
                } catch { /* non-fatal */ }
              }

              results.dataCells++;
            }
          } catch (err) {
            results.failures.push({
              column: col.header,
              row: rowIdx,
              phase: 'insert',
              error: err.message,
            });
          }
        }

        results.columns.push({
          header: col.header,
          style: col.style,
          nodeId: colId, // $resultOf:N — resolved to real ID after flush in the return
          cells: rows.length,
        });
      }

      // ── Flush (no-op with SequentialSender — ops already sent) ──
      await collector.flush(bridge);

      // ── Phase 2: Process deferred cellVariants ──
      // With SequentialSender, cellRef is already a real nodeId (not $resultOf:N).
      for (const cv of pendingCellVariants) {
        const realCellId = cv.cellRef;
        if (!realCellId) continue;

        try {
          const children = await bridge.send('get_node_children', {
            nodeId: realCellId, depth: 1,
          });
          results.totalOperations++;
          const nestedInstances = (children?.children || [])
            .filter(c => c.type === 'INSTANCE');

          let applied = false;
          for (const child of nestedInstances) {
            try {
              await bridge.send('set_variant', {
                nodeId: child.id,
                properties: cv.variantProps,
              });
              results.totalOperations++;
              applied = true;
              break;
            } catch { /* try next */ }
          }

          // Fallback: try on cell itself
          if (!applied) {
            await bridge.send('set_variant', {
              nodeId: realCellId,
              properties: cv.variantProps,
            });
            results.totalOperations++;
          }
        } catch { /* non-fatal */ }
      }

      session.toolCallCount += results.totalOperations;
      advancePhase(3);

      const totalCells = results.headerCells + results.dataCells;
      return {
        tableBodyId: tableBodyId,
        columns: results.columns,
        summary: {
          headerCells: results.headerCells,
          dataCells: results.dataCells,
          totalComponents: totalCells,
          totalOperations: results.totalOperations,
          failures: results.failures.length,
          cellHeight: cellHeight || 'HUG (no fixed height)',
        },
        ...(results.failures.length > 0 ? {
          failures: results.failures,
          _failureNote: 'Some cells had variant or text errors. Check failures array for details.',
        } : {}),
        hint: results.failures.length > 0
          ? `Table built with ${totalCells} components (${results.failures.length} warnings). Check failures for details.`
          : `Table built successfully: ${results.headerCells} headers + ${results.dataCells} data cells = ${totalCells} components in ${results.totalOperations} bridge operations (vs ~${totalCells * 3} tool calls manually).`,
        _reportReminder: 'When the build is done, you MUST call mimic_generate_build_report before responding to the user.',
      };
    },
    {
      annotations: { title: 'Bulk-build a data table', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }
  );
}

module.exports = {
  register,
  // exported for unit testing
  _internal: { insertTextNodes, insertVariantProps, resolveStyleVariant, findPropName, collectTextNodes },
};
