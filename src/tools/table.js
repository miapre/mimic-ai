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

const { BatchCollector } = require('../utils/batch-collector');

function register(server, context) {
  const { bridge, dsCache, session, requirePhase, advancePhase, registerTool, knowledgeStore } = context;

  registerTool(
    'mimic_build_table',
    'Builds an entire data table in one call. Creates column frames with DS Table header cell and Table cell components, configures all variants, text, and sizing. Requires table cell components in the DS — if missing, returns guidance on creating them. Reduces table builds from 200+ tool calls to 1.',
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
      },
      required: ['parentId', 'columns', 'rows'],
    },
    async (args) => {
      requirePhase(2, 'Complete DS Discovery first.');

      const { parentId, columns, rows, cellHeight, headerVariant } = args;

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

      // Batch collector — linear ops go through this, flushed before cellVariants
      const collector = new BatchCollector();

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

            // Set header text
            headerOps.push(collector.send('set_component_text', {
              nodeId: headerResult.nodeId,
              textNodeName: 'Text',
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
              const cellOps = [];

              // Set variant: Supporting text first (must be set before Style
              // to avoid invalid variant combinations)
              cellOps.push(collector.send('set_variant', {
                nodeId: cellResult.nodeId,
                properties: { 'Supporting text': hasSupportingText ? 'True' : 'False' },
              }));

              await Promise.all(cellOps);
              results.totalOperations++;

              // Now set Style (after Supporting text is resolved)
              const styleOps = [];
              try {
                await collector.send('set_variant', {
                  nodeId: cellResult.nodeId,
                  properties: { Style: col.style },
                });
                results.totalOperations++;
              } catch (styleErr) {
                // Style variant might not be valid — fall back to default
                results.failures.push({
                  column: col.header,
                  row: rowIdx,
                  phase: 'style',
                  error: `Style "${col.style}" failed: ${styleErr.message}. Cell left at default style.`,
                });
              }

              // Set text content
              try {
                await collector.send('set_component_text', {
                  nodeId: cellResult.nodeId,
                  textNodeName: 'Text',
                  content: text,
                });
                results.totalOperations++;
              } catch (textErr) {
                // Text node name might differ per style variant — try fallback
                results.failures.push({
                  column: col.header,
                  row: rowIdx,
                  phase: 'text',
                  error: textErr.message,
                });
              }

              // Set supporting text if applicable
              if (hasSupportingText) {
                try {
                  await collector.send('set_component_text', {
                    nodeId: cellResult.nodeId,
                    textNodeName: 'Supporting text',
                    content: supportingText,
                  });
                  results.totalOperations++;
                } catch { /* supporting text node may not exist in this style */ }
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

      // ── Flush: send all collected ops as one batch ──
      await collector.flush(bridge);

      // ── Phase 2: Process deferred cellVariants (need real nodeIds) ──
      for (const cv of pendingCellVariants) {
        const realCellId = collector.getRealNodeId(cv.cellRef);
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
        tableBodyId: collector.getRealNodeId(tableBodyId) || tableBodyId,
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
    }
  );
}

module.exports = { register };
