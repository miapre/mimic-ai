'use strict';

/**
 * ChartCalculator — pure math for all chart geometry.
 *
 * Every chart type gets its own method. The LLM never computes angles,
 * SVG paths, or trig — this module does it all in Node.js.
 */
class ChartCalculator {
  /**
   * Bar chart geometry.
   * Scales bar heights proportionally: (value / maxValue) * chartHeight.
   *
   * @param {Object} opts
   * @param {{ label: string, value: number }[]} opts.data
   * @param {number} opts.chartHeight
   * @returns {{ bars: { label: string, value: number, height: number }[] }}
   */
  bar({ data, chartHeight }) {
    const maxValue = Math.max(...data.map((d) => d.value));
    const bars = data.map((d) => ({
      label: d.label,
      value: d.value,
      height: maxValue === 0 ? 0 : (d.value / maxValue) * chartHeight,
    }));
    return { bars };
  }

  /**
   * Donut / pie chart geometry.
   * Cumulative angles in radians; last segment ends at exactly 2*PI.
   *
   * @param {Object} opts
   * @param {{ label: string, value: number }[]} opts.data
   * @param {number} opts.outerRadius
   * @param {number} opts.innerRadius  ratio (0-1) of outerRadius
   * @returns {{ segments: { label: string, value: number, startingAngle: number, endingAngle: number, outerRadius: number, innerRadius: number }[] }}
   */
  donut({ data, outerRadius, innerRadius }) {
    const total = data.reduce((sum, d) => sum + d.value, 0);
    const TWO_PI = Math.PI * 2;
    const inner = outerRadius * innerRadius;
    let angle = 0;

    const segments = data.map((d, i) => {
      const startingAngle = angle;
      // Force last segment to end at exactly 2*PI to avoid floating-point drift
      const endingAngle =
        i === data.length - 1 ? TWO_PI : angle + (d.value / total) * TWO_PI;
      angle = endingAngle;
      return {
        label: d.label,
        value: d.value,
        startingAngle,
        endingAngle,
        outerRadius,
        innerRadius: inner,
      };
    });

    return { segments };
  }

  /**
   * Line chart geometry.
   * Normalizes data points to plotWidth/plotHeight and builds an SVG path.
   *
   * @param {Object} opts
   * @param {{ x: number, y: number }[]} opts.data
   * @param {number} opts.plotWidth
   * @param {number} opts.plotHeight
   * @returns {{ pathD: string, points: { x: number, y: number, px: number, py: number }[] }}
   */
  line({ data, plotWidth, plotHeight }) {
    const xs = data.map((d) => d.x);
    const ys = data.map((d) => d.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;

    const points = data.map((d) => {
      const px = ((d.x - minX) / rangeX) * plotWidth;
      // y is inverted: high values go up (lower py)
      const py = plotHeight - ((d.y - minY) / rangeY) * plotHeight;
      return { x: d.x, y: d.y, px, py };
    });

    const pathD = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.px},${p.py}`)
      .join(' ');

    return { pathD, points };
  }

  /**
   * Radar chart geometry.
   * Computes vertex positions using trig and generates grid SVG.
   *
   * @param {Object} opts
   * @param {{ label: string, value: number }[]} opts.data
   * @param {number} opts.maxValue
   * @param {number} opts.radius
   * @param {number} opts.cx  center x
   * @param {number} opts.cy  center y
   * @param {number} [opts.gridLevels=5]
   * @returns {{ vertices: { label: string, value: number, x: number, y: number }[], polygonPoints: string, gridSvg: string, labelPositions: { label: string, x: number, y: number }[] }}
   */
  radar({ data, maxValue, radius, cx, cy, gridLevels = 5 }) {
    const n = data.length;
    const angleStep = (Math.PI * 2) / n;
    // Start from top (-PI/2) so first axis points up
    const startAngle = -Math.PI / 2;

    // Compute vertex positions for the data polygon
    const vertices = data.map((d, i) => {
      const angle = startAngle + i * angleStep;
      const r = (d.value / maxValue) * radius;
      return {
        label: d.label,
        value: d.value,
        x: cx + r * Math.cos(angle),
        y: cy + r * Math.sin(angle),
      };
    });

    const polygonPoints = vertices.map((v) => `${v.x},${v.y}`).join(' ');

    // Grid rings (concentric polygons)
    const gridParts = [];
    for (let level = 1; level <= gridLevels; level++) {
      const levelRadius = (level / gridLevels) * radius;
      const ringPoints = [];
      for (let i = 0; i < n; i++) {
        const angle = startAngle + i * angleStep;
        const x = cx + levelRadius * Math.cos(angle);
        const y = cy + levelRadius * Math.sin(angle);
        ringPoints.push(`${x},${y}`);
      }
      gridParts.push(
        `<polygon points="${ringPoints.join(' ')}" fill="none" stroke="#e0e0e0" stroke-width="1"/>`,
      );
    }

    // Axis lines from center to each vertex direction
    for (let i = 0; i < n; i++) {
      const angle = startAngle + i * angleStep;
      const x = cx + radius * Math.cos(angle);
      const y = cy + radius * Math.sin(angle);
      gridParts.push(
        `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#e0e0e0" stroke-width="1"/>`,
      );
    }

    // Label positions slightly outside the outer ring
    const labelOffset = 1.15;
    const labelPositions = data.map((d, i) => {
      const angle = startAngle + i * angleStep;
      return {
        label: d.label,
        x: cx + radius * labelOffset * Math.cos(angle),
        y: cy + radius * labelOffset * Math.sin(angle),
      };
    });

    return {
      vertices,
      polygonPoints,
      gridSvg: gridParts.join('\n'),
      labelPositions,
    };
  }

  /**
   * Scatter plot geometry.
   * Normalizes x/y to plot dimensions. y is inverted (Figma y goes down).
   *
   * @param {Object} opts
   * @param {{ x: number, y: number }[]} opts.data
   * @param {number} opts.plotWidth
   * @param {number} opts.plotHeight
   * @returns {{ points: { x: number, y: number, px: number, py: number }[] }}
   */
  scatter({ data, plotWidth, plotHeight }) {
    const xs = data.map((d) => d.x);
    const ys = data.map((d) => d.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;

    const points = data.map((d) => ({
      x: d.x,
      y: d.y,
      px: ((d.x - minX) / rangeX) * plotWidth,
      py: plotHeight - ((d.y - minY) / rangeY) * plotHeight,
    }));

    return { points };
  }

  /**
   * Heatmap geometry.
   * Calculates intensity (0-1) from value / maxValue, plus cell positions.
   *
   * @param {Object} opts
   * @param {{ row: number, col: number, value: number }[]} opts.data
   * @param {number} opts.cellWidth
   * @param {number} opts.cellHeight
   * @returns {{ cells: { row: number, col: number, value: number, intensity: number, x: number, y: number, width: number, height: number }[] }}
   */
  heatmap({ data, cellWidth, cellHeight }) {
    const maxValue = Math.max(...data.map((d) => d.value));

    const cells = data.map((d) => ({
      row: d.row,
      col: d.col,
      value: d.value,
      intensity: maxValue === 0 ? 0 : d.value / maxValue,
      x: d.col * cellWidth,
      y: d.row * cellHeight,
      width: cellWidth,
      height: cellHeight,
    }));

    return { cells };
  }
}

module.exports = { ChartCalculator };
