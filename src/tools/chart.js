'use strict';

/**
 * mimic_build_chart — Bulk chart builder.
 *
 * Creates an entire chart in one tool call: container frame,
 * SVG/native visualization, axis labels, grid lines, legend.
 * All elements bound to DS variables.
 *
 * Reduces a chart build from 30-50 tool calls to 1.
 */

const { ChartCalculator } = require('../charts/calculator');

// ── Hardcoded defaults (LayerLens Theme) ─────────────────────
// These are used ONLY when the DS cache doesn't have matches
// and the caller doesn't provide overrides.
const FALLBACK_COLORS = [
  'Component colors/Utility/Brand/utility-brand-500',
  'Component colors/Utility/Success/utility-success-500',
  'Component colors/Utility/Warning/utility-warning-500',
  'Component colors/Utility/Error/utility-error-500',
  'Component colors/Utility/Indigo/utility-indigo-500',
  'Component colors/Utility/Purple/utility-purple-500',
  'Component colors/Utility/Blue/utility-blue-500',
  'Component colors/Utility/Orange/utility-orange-500',
];
const FALLBACK_GRID_COLOR = 'Colors/Border/border-secondary';
const FALLBACK_LABEL_COLOR = 'Colors/Text/text-tertiary (600)';
const FALLBACK_LABEL_STYLE = 'Text xs/Medium';
const FALLBACK_TITLE_STYLE = 'Text sm/Semibold';
const FALLBACK_TITLE_COLOR = 'Colors/Text/text-primary (900)';

/**
 * Resolve chart theme from DS cache with optional overrides.
 * Priority: explicit override > DS cache match > hardcoded fallback.
 */
function resolveChartTheme(dsCache, overrides = {}) {
  // Try to find DS-appropriate values from the cache
  const cached = {
    gridColor: dsCache.findVariable?.('border', 'STROKE', 'secondary') || FALLBACK_GRID_COLOR,
    labelColor: dsCache.findVariable?.('text', 'TEXT_FILL', 'tertiary') || FALLBACK_LABEL_COLOR,
    labelStyle: dsCache.findTextStyle?.('xs', 'Medium') || FALLBACK_LABEL_STYLE,
    titleStyle: dsCache.findTextStyle?.('sm', 'Semibold') || FALLBACK_TITLE_STYLE,
    titleColor: dsCache.findVariable?.('text', 'TEXT_FILL', 'primary') || FALLBACK_TITLE_COLOR,
    palette: dsCache.findPalette?.() || FALLBACK_COLORS,
  };

  // Explicit overrides win
  return {
    gridColor: overrides.gridColor || cached.gridColor,
    labelColor: overrides.labelColor || cached.labelColor,
    labelStyle: overrides.labelStyle || cached.labelStyle,
    titleStyle: overrides.titleStyle || cached.titleStyle,
    titleColor: overrides.titleColor || cached.titleColor,
    palette: overrides.colors || cached.palette,
  };
}

const { BatchCollector } = require('../utils/batch-collector');

function register(server, context) {
  const { bridge, dsCache, session, requirePhase, advancePhase, registerTool } = context;
  const calc = new ChartCalculator();

  registerTool(
    'mimic_build_chart',
    'Builds an entire chart in one tool call. Creates chart container, visualization (SVG or native rectangles), axis labels, grid lines, and legend — all bound to DS variables. Supports line, bar, donut, and radar charts. Reduces chart builds from 30-50 tool calls to 1.',
    {
      type: 'object',
      properties: {
        parentId: {
          type: 'string',
          description: 'Parent node ID to insert the chart into.',
        },
        chartType: {
          type: 'string',
          enum: ['line', 'bar', 'donut', 'radar'],
          description: 'The type of chart to build.',
        },
        title: {
          type: 'string',
          description: 'Chart card title text.',
        },
        data: {
          type: 'array',
          description: 'Chart data points. Bar: [{label, value}]. Donut: [{label, value}]. Line: [{label, value}] or [{x, y}]. Radar: [{label, value}] or [{label, values: [v1, v2]}] for multi-series.',
        },
        dimensions: {
          type: 'object',
          description: 'Chart dimensions. Bar: {chartHeight, chartWidth?}. Donut: {outerRadius, innerRadius}. Line: {plotWidth, plotHeight}. Radar: {radius}. Optional for bar/line: yPrefix, ySuffix.',
        },
        seriesNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Legend labels for multi-series charts (e.g. ["Current", "Target"]). For donut charts, legend is auto-generated from data labels.',
        },
        colors: {
          type: 'array',
          items: { type: 'string' },
          description: 'DS color variable paths for data elements. Falls back to DS cache palette or default.',
        },
        gridColor: {
          type: 'string',
          description: 'DS variable path for grid lines. Falls back to DS cache border/secondary match.',
        },
        labelColor: {
          type: 'string',
          description: 'DS variable path for axis label text color. Falls back to DS cache text/tertiary match.',
        },
        labelStyle: {
          type: 'string',
          description: 'DS text style name for axis labels. Falls back to smallest text style in DS cache.',
        },
        titleStyle: {
          type: 'string',
          description: 'DS text style name for chart title. Falls back to DS cache sm/Semibold match.',
        },
        titleColor: {
          type: 'string',
          description: 'DS variable path for title text color. Falls back to DS cache text/primary match.',
        },
      },
      required: ['parentId', 'chartType', 'title', 'data', 'dimensions'],
    },
    async (args) => {
      requirePhase(2, 'Complete DS Discovery first.');

      const { parentId, chartType, title, data, dimensions, seriesNames } = args;

      // Resolve DS-aware theme: explicit overrides > cache matches > hardcoded fallbacks
      const theme = resolveChartTheme(dsCache, {
        colors: args.colors,
        gridColor: args.gridColor,
        labelColor: args.labelColor,
        labelStyle: args.labelStyle,
        titleStyle: args.titleStyle,
        titleColor: args.titleColor,
      });
      const palette = theme.palette;

      const results = {
        totalOperations: 0,
        failures: [],
        elements: { frames: 0, texts: 0, rectangles: 0, svgs: 0, bindings: 0 },
      };

      // Helper: track operations
      const op = () => { results.totalOperations++; };
      const fail = (phase, error) => { results.failures.push({ phase, error: typeof error === 'string' ? error : error.message }); };

      // ── 1. Compute geometry ──
      let geometry;
      try {
        switch (chartType) {
          case 'bar':
            geometry = calc.bar({
              data,
              chartHeight: dimensions.chartHeight || 200,
              chartWidth: dimensions.chartWidth,
              yPrefix: dimensions.yPrefix || '',
              ySuffix: dimensions.ySuffix || '',
            });
            break;
          case 'donut':
            geometry = calc.donut({
              data,
              outerRadius: dimensions.outerRadius || 80,
              innerRadius: dimensions.innerRadius || 0.6,
            });
            break;
          case 'line':
            geometry = calc.line({
              data,
              plotWidth: dimensions.plotWidth || 400,
              plotHeight: dimensions.plotHeight || 200,
              yPrefix: dimensions.yPrefix || '',
              ySuffix: dimensions.ySuffix || '',
            });
            break;
          case 'radar':
            geometry = calc.radar({
              data,
              maxValue: dimensions.maxValue,
              radius: dimensions.radius || 100,
              cx: dimensions.cx || (dimensions.radius || 100),
              cy: dimensions.cy || (dimensions.radius || 100),
              gridLevels: dimensions.gridLevels || 5,
            });
            break;
          default:
            return { error: 'UNSUPPORTED_CHART_TYPE', message: `Unsupported chartType: ${chartType}. Use line, bar, donut, or radar.` };
        }
      } catch (err) {
        return { error: 'GEOMETRY_FAILED', message: `Chart geometry calculation failed: ${err.message}` };
      }

      // ── 2. Batch execution via collector ──
      // Linear ops go through the collector; SVG ops flush first then use bridge directly.
      const collector = new BatchCollector();

      let cardId;
      try {
        const cardResult = await collector.send('create_frame', {
          parentId,
          name: `Chart: ${title}`,
          direction: 'VERTICAL',
          layoutSizingHorizontal: 'FILL',
          layoutSizingVertical: 'HUG',
          paddingVariable: 'spacing-xl',
          gapVariable: 'spacing-lg',
        });
        cardId = cardResult?.nodeId;
        op();
        results.elements.frames++;
      } catch (err) {
        return { error: 'CARD_CONTAINER_FAILED', message: err.message };
      }

      // ── 3. Create title text ──
      try {
        await collector.send('create_text', {
          parentId: cardId,
          name: 'Chart Title',
          content: title,
          textStyleId: theme.titleStyle,
          fillVariable: theme.titleColor,
          layoutSizingHorizontal: 'FILL',
        });
        op();
        results.elements.texts++;
      } catch (err) {
        fail('title', err);
      }

      // ── Dispatch to chart-type-specific builder ──
      // Builders receive both collector (for linear ops) and bridge (for SVG ops).
      // Builders call collector.flush(bridge) before any SVG/read-then-write operation.
      switch (chartType) {
        case 'bar':
          await buildBarChart(collector, bridge, cardId, geometry, palette, dimensions, results, op, fail, theme);
          break;
        case 'donut':
          await buildDonutChart(collector, bridge, cardId, geometry, palette, seriesNames, results, op, fail, theme);
          break;
        case 'line':
          await buildLineChart(collector, bridge, cardId, geometry, palette, seriesNames, dimensions, results, op, fail, theme);
          break;
        case 'radar':
          await buildRadarChart(collector, bridge, cardId, geometry, palette, seriesNames, dimensions, results, op, fail, theme);
          break;
      }

      // Flush any remaining collected ops
      if (collector.ops.length > 0) {
        await collector.flush(bridge);
      }

      session.toolCallCount += results.totalOperations;
      advancePhase(3);

      const totalElements = results.elements.frames + results.elements.texts +
        results.elements.rectangles + results.elements.svgs;
      return {
        chartCardId: cardId,
        chartType,
        geometry,
        summary: {
          totalElements,
          ...results.elements,
          totalOperations: results.totalOperations,
          failures: results.failures.length,
          equivalentManualCalls: `~${Math.max(totalElements * 2, 30)} tool calls`,
        },
        ...(results.failures.length > 0 ? {
          failures: results.failures,
          _failureNote: 'Some elements had errors. Check failures array for details.',
        } : {}),
        hint: results.failures.length > 0
          ? `Chart "${title}" built with ${totalElements} elements (${results.failures.length} warnings). Check failures.`
          : `Chart "${title}" built successfully: ${totalElements} elements in ${results.totalOperations} bridge operations.`,
        _reportReminder: 'When the build is done, you MUST call mimic_generate_build_report before responding to the user.',
      };
    }
  );
}

// ═══════════════════════════════════════════════════════════════
// BAR CHART
// Native rectangles in a horizontal frame, aligned bottom.
// ═══════════════════════════════════════════════════════════════
async function buildBarChart(collector, bridge, cardId, geometry, palette, dimensions, results, op, fail, theme) {
  const { bars, yAxis, xAxis, chartWidth } = geometry;
  const chartHeight = dimensions.chartHeight || 200;

  // Pure auto-layout approach: Y-axis column + Bars column side by side
  // No NONE frames, no absolute positioning.

  // Chart body: HORIZONTAL (y-axis labels | bars area)
  let chartBodyId;
  try {
    const r = await collector.send('create_frame', {
      parentId: cardId,
      name: 'Chart Body',
      direction: 'HORIZONTAL',
      layoutSizingHorizontal: 'FILL',
      layoutSizingVertical: 'HUG',
      gapVariable: 'spacing-md',
    });
    chartBodyId = r?.nodeId;
    op();
    results.elements.frames++;
  } catch (err) {
    fail('chart-body', err);
    return;
  }

  // ── Y-axis: VERTICAL, SPACE_BETWEEN, fixed height ──
  let yAxisId;
  try {
    const r = await collector.send('create_frame', {
      parentId: chartBodyId,
      name: 'Y Axis',
      direction: 'VERTICAL',
      layoutSizingHorizontal: 'HUG',
      height: chartHeight,
      layoutSizingVertical: 'FIXED',
      primaryAxisAlignItems: 'SPACE_BETWEEN',
    });
    yAxisId = r?.nodeId;
    op();
    results.elements.frames++;
  } catch (err) {
    fail('y-axis-frame', err);
  }

  if (yAxisId) {
    // Reverse: highest value at top, 0 at bottom (SPACE_BETWEEN distributes top→bottom)
    const reversedTicks = [...yAxis.ticks].reverse();
    for (const tick of reversedTicks) {
      try {
        await collector.send('create_text', {
          parentId: yAxisId,
          name: `Y: ${tick.label}`,
          content: tick.label,
          textStyleId: theme.labelStyle,
          fillVariable: theme.labelColor,
          textAlignHorizontal: 'RIGHT',
        });
        op();
        results.elements.texts++;
      } catch (err) {
        fail('y-label', err);
      }
    }
  }

  // ── Bars area: HORIZONTAL, bottom-aligned, FILL width ──
  let barsFrameId;
  try {
    const r = await collector.send('create_frame', {
      parentId: chartBodyId,
      name: 'Bars',
      direction: 'HORIZONTAL',
      layoutSizingHorizontal: 'FILL',
      height: chartHeight,
      layoutSizingVertical: 'FIXED',
      counterAxisAlignItems: 'MAX',
      primaryAxisAlignItems: 'SPACE_BETWEEN',
    });
    barsFrameId = r?.nodeId;
    op();
    results.elements.frames++;
  } catch (err) {
    fail('bars-frame', err);
    return;
  }

  // Grid lines (absolute-positioned inside AL bars frame — overlay behind bars)
  for (const tick of yAxis.ticks) {
    try {
      await collector.send('create_rectangle', {
        parentId: barsFrameId,
        name: `Grid ${tick.label}`,
        width: 9999,
        height: 1,
        fillVariable: theme.gridColor,
        layoutPositioning: 'ABSOLUTE',
        x: 0,
        y: tick.py,
      });
      op();
      results.elements.rectangles++;
    } catch (err) {
      fail('grid-line', err);
    }
  }

  // Individual bars
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const color = palette[i % palette.length];
    try {
      await collector.send('create_rectangle', {
        parentId: barsFrameId,
        name: `Bar: ${bar.label}`,
        height: Math.max(2, bar.height),
        layoutSizingHorizontal: 'FILL',
        fillVariable: color,
        radiusVariable: 'radius-xs',
      });
      op();
      results.elements.rectangles++;
    } catch (err) {
      fail('bar', err);
    }
  }

  // ── X-axis labels ──
  let xAxisId;
  try {
    const r = await collector.send('create_frame', {
      parentId: cardId,
      name: 'X Axis',
      direction: 'HORIZONTAL',
      layoutSizingHorizontal: 'FILL',
      layoutSizingVertical: 'HUG',
      counterAxisAlignItems: 'CENTER',
    });
    xAxisId = r?.nodeId;
    op();
    results.elements.frames++;
  } catch (err) {
    fail('x-axis-frame', err);
  }

  if (xAxisId) {
    // Spacer to align with y-axis width
    try {
      await collector.send('create_rectangle', {
        parentId: xAxisId,
        name: 'X Axis Spacer',
        width: 40,
        height: 1,
        layoutSizingHorizontal: 'FIXED',
      });
      op();
      results.elements.rectangles++;
    } catch (err) {
      fail('x-spacer', err);
    }

    // Label frame with SPACE_BETWEEN
    let xLabelsId;
    try {
      const r = await collector.send('create_frame', {
        parentId: xAxisId,
        name: 'X Labels',
        direction: 'HORIZONTAL',
        layoutSizingHorizontal: 'FILL',
        layoutSizingVertical: 'HUG',
        primaryAxisAlignItems: 'SPACE_BETWEEN',
      });
      xLabelsId = r?.nodeId;
      op();
      results.elements.frames++;
    } catch (err) {
      fail('x-labels-frame', err);
    }

    if (xLabelsId) {
      for (const label of xAxis.labels) {
        try {
          await collector.send('create_text', {
            parentId: xLabelsId,
            name: `X: ${label.label}`,
            content: label.label,
            textStyleId: theme.labelStyle,
            fillVariable: theme.labelColor,
            textAlignHorizontal: 'CENTER',
          });
          op();
          results.elements.texts++;
        } catch (err) {
          fail('x-label', err);
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// DONUT CHART
// SVG with filled arc segments + native legend with colored rects.
// ═══════════════════════════════════════════════════════════════
async function buildDonutChart(collector, bridge, cardId, geometry, palette, seriesNames, results, op, fail, theme) {
  const { segments, diameter, legend } = geometry;

  // Chart + legend container
  let donutAreaId;
  try {
    const r = await collector.send('create_frame', {
      parentId: cardId,
      name: 'Donut Area',
      direction: 'VERTICAL',
      layoutSizingHorizontal: 'FILL',
      layoutSizingVertical: 'HUG',
      gapVariable: 'spacing-lg',
      counterAxisAlignItems: 'CENTER',
    });
    donutAreaId = r?.nodeId;
    op();
    results.elements.frames++;
  } catch (err) {
    fail('donut-area', err);
    return;
  }

  // Build SVG with all segments (fill only, no stroke)
  const svgParts = segments.map((seg, i) => {
    // Use a placeholder fill — we'll bind to DS variables after creation
    const hue = (i * 60) % 360;
    return `<path d="${seg.pathD}" fill="hsl(${hue}, 60%, 50%)" />`;
  });

  const svgString = `<svg viewBox="0 0 ${diameter} ${diameter}" xmlns="http://www.w3.org/2000/svg">${svgParts.join('')}</svg>`;

  // Flush collector before SVG (need real nodeIds for parentId + unboundChildren)
  await collector.flush(bridge);
  const realDonutAreaId = collector.getRealNodeId(donutAreaId);

  let svgResult;
  try {
    svgResult = await bridge.send('create_svg', {
      parentId: realDonutAreaId,
      name: 'Donut Chart',
      svgString,
    });
    op();
    results.elements.svgs++;
  } catch (err) {
    fail('donut-svg', err);
    return;
  }

  // Bind each vector child to DS color variable
  const unboundChildren = svgResult?.unboundChildren || [];
  const vectorChildren = unboundChildren.filter(c => c.type !== 'TEXT');
  for (let i = 0; i < vectorChildren.length && i < segments.length; i++) {
    const color = palette[i % palette.length];
    try {
      await bridge.send('set_node_fill', {
        nodeId: vectorChildren[i].nodeId,
        fillVariable: color,
      });
      op();
      results.elements.bindings++;
    } catch (err) {
      fail('donut-bind', err);
    }
  }

  // ── Legend ──
  let legendFrameId;
  try {
    const r = await collector.send('create_frame', {
      parentId: realDonutAreaId,
      name: 'Legend',
      direction: 'HORIZONTAL',
      layoutSizingHorizontal: 'HUG',
      layoutSizingVertical: 'HUG',
      gapVariable: 'spacing-xl',
      primaryAxisAlignItems: 'CENTER',
    });
    legendFrameId = r?.nodeId;
    op();
    results.elements.frames++;
  } catch (err) {
    fail('legend-frame', err);
  }

  if (legendFrameId) {
    for (let i = 0; i < legend.length; i++) {
      const entry = legend[i];
      const color = palette[i % palette.length];

      // Legend item frame
      let itemId;
      try {
        const r = await collector.send('create_frame', {
          parentId: legendFrameId,
          name: `Legend: ${entry.label}`,
          direction: 'HORIZONTAL',
          layoutSizingHorizontal: 'HUG',
          layoutSizingVertical: 'HUG',
          gapVariable: 'spacing-xs',
          counterAxisAlignItems: 'CENTER',
        });
        itemId = r?.nodeId;
        op();
        results.elements.frames++;
      } catch (err) {
        fail('legend-item', err);
        continue;
      }

      // Color dot (rectangle with radius-full)
      try {
        await collector.send('create_rectangle', {
          parentId: itemId,
          name: `Dot: ${entry.label}`,
          width: 8,
          height: 8,
          fillVariable: color,
          radiusVariable: 'radius-full',
        });
        op();
        results.elements.rectangles++;
      } catch (err) {
        fail('legend-dot', err);
      }

      // Label text
      try {
        await collector.send('create_text', {
          parentId: itemId,
          name: `Label: ${entry.label}`,
          content: entry.displayText,
          textStyleId: theme.labelStyle,
          fillVariable: theme.labelColor,
        });
        op();
        results.elements.texts++;
      } catch (err) {
        fail('legend-text', err);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// LINE CHART
// Area fill SVG (closed path, fill only, NO stroke) +
// thin ribbon SVG for data line + native text for axes.
// ═══════════════════════════════════════════════════════════════
async function buildLineChart(collector, bridge, cardId, geometry, palette, seriesNames, dimensions, results, op, fail, theme) {
  const { points, yAxis, xAxis } = geometry;
  const plotWidth = dimensions.plotWidth || 400;
  const plotHeight = dimensions.plotHeight || 200;

  // Chart area (y-axis + plot side by side)
  let chartAreaId;
  try {
    const r = await collector.send('create_frame', {
      parentId: cardId,
      name: 'Chart Area',
      direction: 'HORIZONTAL',
      layoutSizingHorizontal: 'FILL',
      layoutSizingVertical: 'HUG',
      gapVariable: 'spacing-md',
    });
    chartAreaId = r?.nodeId;
    op();
    results.elements.frames++;
  } catch (err) {
    fail('chart-area', err);
    return;
  }

  // ── Y-axis labels ──
  let yAxisId;
  try {
    const r = await collector.send('create_frame', {
      parentId: chartAreaId,
      name: 'Y Axis',
      direction: 'NONE',
      width: 40,
      height: plotHeight,
      layoutSizingHorizontal: 'FIXED',
      layoutSizingVertical: 'FIXED',
    });
    yAxisId = r?.nodeId;
    op();
    results.elements.frames++;
  } catch (err) {
    fail('y-axis-frame', err);
  }

  if (yAxisId) {
    for (const tick of yAxis.ticks) {
      try {
        await collector.send('create_text', {
          parentId: yAxisId,
          name: `Y: ${tick.label}`,
          content: tick.label,
          textStyleId: theme.labelStyle,
          fillVariable: theme.labelColor,
          x: 0,
          y: Math.max(0, tick.py - 6),
        });
        op();
        results.elements.texts++;
      } catch (err) {
        fail('y-label', err);
      }
    }
  }

  // ── Plot area (NONE direction, fixed size) ──
  let plotId;
  try {
    const r = await collector.send('create_frame', {
      parentId: chartAreaId,
      name: 'Plot Area',
      direction: 'NONE',
      layoutSizingHorizontal: 'FILL',
      height: plotHeight,
      layoutSizingVertical: 'FIXED',
    });
    plotId = r?.nodeId;
    op();
    results.elements.frames++;
  } catch (err) {
    fail('plot-area', err);
    return;
  }

  // Grid lines (horizontal rectangles)
  for (const tick of yAxis.ticks) {
    try {
      await collector.send('create_rectangle', {
        parentId: plotId,
        name: `Grid ${tick.label}`,
        width: 9999,
        height: 1,
        fillVariable: theme.gridColor,
        x: 0,
        y: tick.py,
      });
      op();
      results.elements.rectangles++;
    } catch (err) {
      fail('grid-line', err);
    }
  }

  // Flush collector before SVG operations (need real nodeIds)
  await collector.flush(bridge);
  const realPlotId = collector.getRealNodeId(plotId);
  const realCardIdLine = collector.getRealNodeId(cardId);

  // Area fill SVG (closed polygon, fill only, NO stroke)
  if (points.length >= 2) {
    const color = palette[0];
    // Build closed area path: trace points left to right, then close via bottom
    const areaPathParts = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.px.toFixed(2)},${p.py.toFixed(2)}`);
    // Close via bottom-right → bottom-left
    areaPathParts.push(`L${points[points.length - 1].px.toFixed(2)},${plotHeight}`);
    areaPathParts.push(`L${points[0].px.toFixed(2)},${plotHeight}`);
    areaPathParts.push('Z');
    const areaPath = areaPathParts.join(' ');

    const areaSvg = `<svg viewBox="0 0 ${plotWidth} ${plotHeight}" xmlns="http://www.w3.org/2000/svg"><path d="${areaPath}" fill="#4080ff" opacity="0.15" /></svg>`;

    let areaResult;
    try {
      areaResult = await bridge.send('create_svg', {
        parentId: realPlotId,
        name: 'Area Fill',
        svgString: areaSvg,
        layoutSizingHorizontal: 'FILL',
        x: 0,
        y: 0,
      });
      op();
      results.elements.svgs++;

      // Bind area fill vector to DS color
      const areaChildren = areaResult?.unboundChildren || [];
      const areaVectors = areaChildren.filter(c => c.type !== 'TEXT');
      if (areaVectors.length > 0) {
        try {
          await bridge.send('set_node_fill', {
            nodeId: areaVectors[0].nodeId,
            fillVariable: color,
          });
          op();
          results.elements.bindings++;
        } catch (err) {
          fail('area-bind', err);
        }
      }
    } catch (err) {
      fail('area-svg', err);
    }

    // Data line ribbon (thin filled shape, 2px thick, NO stroke)
    const ribbonThickness = 1.5;
    const ribbonTop = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.px.toFixed(2)},${(p.py - ribbonThickness).toFixed(2)}`);
    // Reverse bottom
    const ribbonBottom = [...points].reverse().map((p, i) => `${i === 0 ? 'L' : 'L'}${p.px.toFixed(2)},${(p.py + ribbonThickness).toFixed(2)}`);
    const ribbonPath = [...ribbonTop, ...ribbonBottom, 'Z'].join(' ');

    const ribbonSvg = `<svg viewBox="0 0 ${plotWidth} ${plotHeight}" xmlns="http://www.w3.org/2000/svg"><path d="${ribbonPath}" fill="#4080ff" /></svg>`;

    let ribbonResult;
    try {
      ribbonResult = await bridge.send('create_svg', {
        parentId: realPlotId,
        name: 'Data Line',
        svgString: ribbonSvg,
        layoutSizingHorizontal: 'FILL',
        x: 0,
        y: 0,
      });
      op();
      results.elements.svgs++;

      // Bind ribbon vector to DS color
      const ribbonChildren = ribbonResult?.unboundChildren || [];
      const ribbonVectors = ribbonChildren.filter(c => c.type !== 'TEXT');
      if (ribbonVectors.length > 0) {
        try {
          await bridge.send('set_node_fill', {
            nodeId: ribbonVectors[0].nodeId,
            fillVariable: color,
          });
          op();
          results.elements.bindings++;
        } catch (err) {
          fail('ribbon-bind', err);
        }
      }
    } catch (err) {
      fail('ribbon-svg', err);
    }

    // Data points (ellipses at each point position)
    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      const pointColor = palette[0];
      try {
        await bridge.send('create_ellipse', {
          parentId: realPlotId,
          name: `Point: ${pt.label}`,
          width: 6,
          height: 6,
          fillVariable: pointColor,
          x: pt.px - 3,
          y: pt.py - 3,
        });
        op();
        results.elements.rectangles++; // count ellipses with rects for simplicity
      } catch (err) {
        fail('data-point', err);
      }
    }
  }

  // ── X-axis labels ──
  let xAxisId;
  try {
    const r = await collector.send('create_frame', {
      parentId: realCardIdLine,
      name: 'X Axis',
      direction: 'HORIZONTAL',
      layoutSizingHorizontal: 'FILL',
      layoutSizingVertical: 'HUG',
    });
    xAxisId = r?.nodeId;
    op();
    results.elements.frames++;
  } catch (err) {
    fail('x-axis-frame', err);
  }

  if (xAxisId) {
    // Spacer for y-axis alignment
    try {
      await collector.send('create_rectangle', {
        parentId: xAxisId,
        name: 'X Axis Spacer',
        width: 40,
        height: 1,
        layoutSizingHorizontal: 'FIXED',
      });
      op();
      results.elements.rectangles++;
    } catch (err) {
      fail('x-spacer', err);
    }

    let xLabelsId;
    try {
      const r = await collector.send('create_frame', {
        parentId: xAxisId,
        name: 'X Labels',
        direction: 'HORIZONTAL',
        layoutSizingHorizontal: 'FILL',
        layoutSizingVertical: 'HUG',
        primaryAxisAlignItems: 'SPACE_BETWEEN',
      });
      xLabelsId = r?.nodeId;
      op();
      results.elements.frames++;
    } catch (err) {
      fail('x-labels-frame', err);
    }

    if (xLabelsId) {
      for (const label of xAxis.labels) {
        try {
          await collector.send('create_text', {
            parentId: xLabelsId,
            name: `X: ${label.label}`,
            content: label.label,
            textStyleId: theme.labelStyle,
            fillVariable: theme.labelColor,
            textAlignHorizontal: 'CENTER',
          });
          op();
          results.elements.texts++;
        } catch (err) {
          fail('x-label', err);
        }
      }
    }
  }

  // ── Legend (only for multi-series) ──
  if (seriesNames && seriesNames.length > 1) {
    await buildLegend(collector, bridge, realCardIdLine, seriesNames, palette, results, op, fail, theme);
  }
}

// ═══════════════════════════════════════════════════════════════
// RADAR CHART
// SVG with filled polygons only (NO stroke). Native text labels.
// ═══════════════════════════════════════════════════════════════
async function buildRadarChart(collector, bridge, cardId, geometry, palette, seriesNames, dimensions, results, op, fail, theme) {
  const { series, gridSvg, labelPositions } = geometry;
  const radius = dimensions.radius || 100;
  const viewSize = radius * 2.5; // extra space for labels
  const cx = dimensions.cx || radius;
  const cy = dimensions.cy || radius;

  // Radar container
  let radarAreaId;
  try {
    const r = await collector.send('create_frame', {
      parentId: cardId,
      name: 'Radar Area',
      direction: 'VERTICAL',
      layoutSizingHorizontal: 'FILL',
      layoutSizingVertical: 'HUG',
      gapVariable: 'spacing-lg',
      counterAxisAlignItems: 'CENTER',
    });
    radarAreaId = r?.nodeId;
    op();
    results.elements.frames++;
  } catch (err) {
    fail('radar-area', err);
    return;
  }

  // Build SVG: grid polygons (filled, no stroke) + data polygons (filled, no stroke)
  const svgParts = [];

  // Grid: concentric filled polygons with decreasing opacity
  const gridLevels = dimensions.gridLevels || 5;
  const n = labelPositions.length;
  const angleStep = (Math.PI * 2) / n;
  const startAngle = -Math.PI / 2;

  for (let level = gridLevels; level >= 1; level--) {
    const levelRadius = (level / gridLevels) * radius;
    const ringPoints = [];
    for (let i = 0; i < n; i++) {
      const angle = startAngle + i * angleStep;
      const x = cx + levelRadius * Math.cos(angle);
      const y = cy + levelRadius * Math.sin(angle);
      ringPoints.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    }
    const opacity = 0.03 + (level / gridLevels) * 0.12;
    svgParts.push(`<polygon points="${ringPoints.join(' ')}" fill="#d0d5dd" fill-opacity="${opacity.toFixed(2)}" />`);
  }

  // Data polygons (filled, low opacity)
  for (let s = 0; s < series.length; s++) {
    const ser = series[s];
    const hue = (s * 120) % 360;
    const opacity = series.length > 1 ? 0.15 : 0.20;
    svgParts.push(`<polygon points="${ser.polygonPoints}" fill="hsl(${hue}, 60%, 50%)" fill-opacity="${opacity}" />`);
  }

  const svgString = `<svg viewBox="0 0 ${viewSize} ${viewSize}" xmlns="http://www.w3.org/2000/svg">${svgParts.join('')}</svg>`;

  // Flush collector before SVG (need real nodeIds)
  await collector.flush(bridge);
  const realRadarAreaId = collector.getRealNodeId(radarAreaId);

  let svgResult;
  try {
    svgResult = await bridge.send('create_svg', {
      parentId: realRadarAreaId,
      name: 'Radar Chart',
      svgString,
    });
    op();
    results.elements.svgs++;
  } catch (err) {
    fail('radar-svg', err);
    return;
  }

  // Bind vector children: grid polygons → border-secondary, data polygons → palette colors
  const unboundChildren = svgResult?.unboundChildren || [];
  const vectorChildren = unboundChildren.filter(c => c.type !== 'TEXT');

  // First gridLevels vectors are grid, rest are data polygons
  for (let i = 0; i < vectorChildren.length; i++) {
    const isGrid = i < gridLevels;
    const color = isGrid ? theme.gridColor : palette[(i - gridLevels) % palette.length];
    try {
      await bridge.send('set_node_fill', {
        nodeId: vectorChildren[i].nodeId,
        fillVariable: color,
      });
      op();
      results.elements.bindings++;
    } catch (err) {
      fail('radar-bind', err);
    }
  }

  // ── Axis labels (native text, positioned outside SVG) ──
  // Place labels in a NONE-direction frame overlapping the SVG
  let labelsFrameId;
  try {
    const r = await collector.send('create_frame', {
      parentId: realRadarAreaId,
      name: 'Radar Labels',
      direction: 'NONE',
      width: viewSize,
      height: viewSize,
      layoutSizingHorizontal: 'FIXED',
      layoutSizingVertical: 'FIXED',
    });
    labelsFrameId = r?.nodeId;
    op();
    results.elements.frames++;
  } catch (err) {
    fail('radar-labels-frame', err);
  }

  if (labelsFrameId) {
    for (const lp of labelPositions) {
      try {
        await collector.send('create_text', {
          parentId: labelsFrameId,
          name: `Label: ${lp.label}`,
          content: lp.label,
          textStyleId: theme.labelStyle,
          fillVariable: theme.labelColor,
          x: Math.max(0, lp.x - 15),
          y: Math.max(0, lp.y - 6),
          textAlignHorizontal: 'CENTER',
        });
        op();
        results.elements.texts++;
      } catch (err) {
        fail('radar-label', err);
      }
    }
  }

  // ── Legend (for multi-series) ──
  if (seriesNames && seriesNames.length > 0) {
    const realCardIdRadar = collector.getRealNodeId(cardId);
    await buildLegend(collector, bridge, realCardIdRadar, seriesNames, palette, results, op, fail, theme);
  }
}

// ═══════════════════════════════════════════════════════════════
// SHARED: Legend builder
// Horizontal row of colored rectangles + label text.
// ═══════════════════════════════════════════════════════════════
async function buildLegend(collector, bridge, parentId, labels, palette, results, op, fail, theme) {
  let legendFrameId;
  try {
    const r = await collector.send('create_frame', {
      parentId,
      name: 'Legend',
      direction: 'HORIZONTAL',
      layoutSizingHorizontal: 'HUG',
      layoutSizingVertical: 'HUG',
      gapVariable: 'spacing-xl',
      primaryAxisAlignItems: 'CENTER',
    });
    legendFrameId = r?.nodeId;
    op();
    results.elements.frames++;
  } catch (err) {
    fail('legend-frame', err);
    return;
  }

  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    const color = palette[i % palette.length];

    let itemId;
    try {
      const r = await collector.send('create_frame', {
        parentId: legendFrameId,
        name: `Legend: ${label}`,
        direction: 'HORIZONTAL',
        layoutSizingHorizontal: 'HUG',
        layoutSizingVertical: 'HUG',
        gapVariable: 'spacing-xs',
        counterAxisAlignItems: 'CENTER',
      });
      itemId = r?.nodeId;
      op();
      results.elements.frames++;
    } catch (err) {
      fail('legend-item', err);
      continue;
    }

    // Color indicator (rectangle, not text dot)
    try {
      await collector.send('create_rectangle', {
        parentId: itemId,
        name: `Dot: ${label}`,
        width: 8,
        height: 8,
        fillVariable: color,
        radiusVariable: 'radius-full',
      });
      op();
      results.elements.rectangles++;
    } catch (err) {
      fail('legend-dot', err);
    }

    // Label text
    try {
      await collector.send('create_text', {
        parentId: itemId,
        name: `Label: ${label}`,
        content: label,
        textStyleId: theme.labelStyle,
        fillVariable: theme.labelColor,
      });
      op();
      results.elements.texts++;
    } catch (err) {
      fail('legend-text', err);
    }
  }
}

module.exports = { register };
