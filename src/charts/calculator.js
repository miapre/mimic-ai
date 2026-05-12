'use strict';

/**
 * ChartCalculator — pure math for all chart geometry.
 *
 * Every chart type gets its own method. The LLM never computes angles,
 * SVG paths, trig, or axis labels — this module does it all in Node.js.
 */
class ChartCalculator {

  /**
   * Compute nice axis ticks for a given range.
   * Returns evenly spaced tick values with human-friendly intervals (1, 2, 5, 10, 20, 25, 50, etc.)
   *
   * @param {number} minVal  minimum data value
   * @param {number} maxVal  maximum data value
   * @param {number} [targetTicks=5]  desired number of ticks
   * @returns {{ ticks: number[], min: number, max: number, step: number }}
   */
  _niceAxis(minVal, maxVal, targetTicks = 5) {
    if (minVal === maxVal) {
      return { ticks: [minVal], min: minVal, max: maxVal, step: 0 };
    }
    const range = maxVal - minVal;
    const roughStep = range / targetTicks;
    const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
    const residual = roughStep / magnitude;

    let niceStep;
    if (residual <= 1.5) niceStep = 1 * magnitude;
    else if (residual <= 3) niceStep = 2 * magnitude;
    else if (residual <= 7) niceStep = 5 * magnitude;
    else niceStep = 10 * magnitude;

    const niceMin = Math.floor(minVal / niceStep) * niceStep;
    const niceMax = Math.ceil(maxVal / niceStep) * niceStep;

    const ticks = [];
    for (let v = niceMin; v <= niceMax + niceStep * 0.01; v += niceStep) {
      ticks.push(Math.round(v * 1e10) / 1e10); // avoid floating point noise
    }

    return { ticks, min: niceMin, max: niceMax, step: niceStep };
  }

  /**
   * Format a tick value for display (e.g. 1500 → "1.5K", 0.25 → "0.25").
   * @param {number} value
   * @param {string} [prefix='']  e.g. '$'
   * @param {string} [suffix='']  e.g. '%' or 'K'
   * @returns {string}
   */
  _formatTick(value, prefix = '', suffix = '') {
    if (Math.abs(value) >= 1000000) return `${prefix}${(value / 1000000).toFixed(1)}M${suffix}`;
    if (Math.abs(value) >= 1000) return `${prefix}${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}K${suffix}`;
    if (Number.isInteger(value)) return `${prefix}${value}${suffix}`;
    return `${prefix}${value.toFixed(1)}${suffix}`;
  }
  /**
   * Bar chart geometry.
   * Scales bar heights using nice Y-axis range. Returns bar positions,
   * Y-axis ticks, and X-axis label positions.
   *
   * @param {Object} opts
   * @param {{ label: string, value: number }[]} opts.data
   * @param {number} opts.chartHeight
   * @param {number} [opts.chartWidth]  total plot width (auto-calculated if omitted)
   * @param {number} [opts.barWidthRatio=0.6]  bar width as ratio of slot width
   * @param {string} [opts.yPrefix='']  prefix for Y-axis labels
   * @param {string} [opts.ySuffix='']  suffix for Y-axis labels
   * @returns {{ bars: object[], yAxis: object, xAxis: object }}
   */
  bar({ data, chartHeight, chartWidth, barWidthRatio = 0.6, yPrefix = '', ySuffix = '' }) {
    const maxValue = Math.max(...data.map((d) => d.value));

    // Compute nice Y-axis
    const yAxisInfo = this._niceAxis(0, maxValue, 5);
    const yRange = yAxisInfo.max - yAxisInfo.min || 1;

    // Bar positioning
    const width = chartWidth || data.length * 70; // default 70px per slot
    const slotWidth = width / data.length;
    const barWidth = slotWidth * barWidthRatio;

    const bars = data.map((d, i) => {
      const height = (d.value / yRange) * chartHeight;
      const x = i * slotWidth + (slotWidth - barWidth) / 2;
      const y = chartHeight - height;
      return {
        label: d.label,
        value: d.value,
        height: Math.round(height * 100) / 100,
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100,
        width: Math.round(barWidth * 100) / 100,
      };
    });

    // Y-axis ticks
    const yAxis = {
      ticks: yAxisInfo.ticks.map((val) => ({
        value: val,
        label: this._formatTick(val, yPrefix, ySuffix),
        py: Math.round((chartHeight - ((val - yAxisInfo.min) / yRange) * chartHeight) * 100) / 100,
      })),
      min: yAxisInfo.min,
      max: yAxisInfo.max,
    };

    // X-axis labels centered under each bar
    const xAxis = {
      labels: bars.map((b) => ({
        label: b.label,
        px: Math.round((b.x + barWidth / 2) * 100) / 100,
      })),
    };

    return { bars, yAxis, xAxis, chartWidth: width };
  }

  /**
   * Donut / pie chart geometry.
   * Returns SVG path strings for each segment so the LLM never computes arc math.
   * Center is at (outerRadius, outerRadius) so the SVG viewBox is 0 0 diameter diameter.
   *
   * @param {Object} opts
   * @param {{ label: string, value: number }[]} opts.data
   * @param {number} opts.outerRadius
   * @param {number} opts.innerRadius  absolute px (>1) or ratio (0-1) of outerRadius
   * @returns {{ segments: object[], svgPaths: string[], center: { x: number, y: number }, diameter: number }}
   */
  donut({ data, outerRadius, innerRadius }) {
    const total = data.reduce((sum, d) => sum + d.value, 0);
    const TWO_PI = Math.PI * 2;
    // innerRadius: if > 1 treat as absolute pixels, if <= 1 treat as ratio
    const inner = innerRadius > 1 ? innerRadius : outerRadius * innerRadius;
    const cx = outerRadius;
    const cy = outerRadius;
    let angle = -Math.PI / 2; // Start from top (12 o'clock)

    const segments = [];
    const svgPaths = [];

    for (let i = 0; i < data.length; i++) {
      const d = data[i];
      const startAngle = angle;
      const sliceAngle = (d.value / total) * TWO_PI;
      // Force last segment to close exactly at start to avoid floating-point drift
      const endAngle = i === data.length - 1 ? (-Math.PI / 2 + TWO_PI) : angle + sliceAngle;
      angle = endAngle;

      // Compute arc endpoints
      const outerX1 = cx + outerRadius * Math.cos(startAngle);
      const outerY1 = cy + outerRadius * Math.sin(startAngle);
      const outerX2 = cx + outerRadius * Math.cos(endAngle);
      const outerY2 = cy + outerRadius * Math.sin(endAngle);
      const innerX1 = cx + inner * Math.cos(endAngle);
      const innerY1 = cy + inner * Math.sin(endAngle);
      const innerX2 = cx + inner * Math.cos(startAngle);
      const innerY2 = cy + inner * Math.sin(startAngle);

      // Large arc flag: 1 if the arc spans more than 180 degrees
      const largeArc = sliceAngle > Math.PI ? 1 : 0;

      // SVG path: outer arc (clockwise) → line to inner → inner arc (counter-clockwise) → close
      const pathD = [
        `M ${outerX1.toFixed(2)} ${outerY1.toFixed(2)}`,
        `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerX2.toFixed(2)} ${outerY2.toFixed(2)}`,
        `L ${innerX1.toFixed(2)} ${innerY1.toFixed(2)}`,
        `A ${inner} ${inner} 0 ${largeArc} 0 ${innerX2.toFixed(2)} ${innerY2.toFixed(2)}`,
        'Z',
      ].join(' ');

      segments.push({
        label: d.label,
        value: d.value,
        percentage: ((d.value / total) * 100).toFixed(1),
        startAngle,
        endAngle,
        outerRadius,
        innerRadius: inner,
        pathD,
      });

      svgPaths.push(pathD);
    }

    // Legend entries with label + percentage
    const legend = segments.map((seg) => ({
      label: seg.label,
      percentage: seg.percentage,
      displayText: `${seg.label} ${seg.percentage}%`,
    }));

    return {
      segments,
      svgPaths,
      center: { x: cx, y: cy },
      diameter: outerRadius * 2,
      legend,
    };
  }

  /**
   * Line chart geometry.
   * Normalizes data points to plotWidth/plotHeight and builds an SVG path.
   * Returns axis information (ticks, labels, grid line positions).
   *
   * @param {Object} opts
   * @param {{ x: number, y: number }[] | { label: string, value: number }[]} opts.data
   * @param {number} opts.plotWidth
   * @param {number} opts.plotHeight
   * @param {string} [opts.yPrefix='']  prefix for Y-axis labels (e.g. '$')
   * @param {string} [opts.ySuffix='']  suffix for Y-axis labels (e.g. '%')
   * @returns {{ pathD: string, points: object[], yAxis: object, xAxis: object }}
   */
  line({ data, plotWidth, plotHeight, yPrefix = '', ySuffix = '' }) {
    // Accept both {x,y} and {label,value} formats
    const normalized = data.map((d, i) => ({
      x: d.x != null ? d.x : i,
      y: d.y != null ? d.y : d.value,
      label: d.label || String(d.x != null ? d.x : i),
    }));
    const ys = normalized.map((d) => d.y);
    const minDataY = Math.min(...ys);
    const maxDataY = Math.max(...ys);

    // Compute nice Y-axis ticks
    const yAxisInfo = this._niceAxis(Math.min(0, minDataY), maxDataY, 5);
    const yRange = yAxisInfo.max - yAxisInfo.min || 1;

    // X positions: evenly spaced across plotWidth
    const xStep = normalized.length > 1 ? plotWidth / (normalized.length - 1) : 0;

    const points = normalized.map((d, i) => {
      const px = i * xStep;
      const py = plotHeight - ((d.y - yAxisInfo.min) / yRange) * plotHeight;
      return { x: d.x, y: d.y, label: d.label, px: Math.round(px * 100) / 100, py: Math.round(py * 100) / 100 };
    });

    const pathD = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.px},${p.py}`)
      .join(' ');

    // Y-axis: tick positions (in SVG y-coordinates) + formatted labels
    const yAxis = {
      ticks: yAxisInfo.ticks.map((val) => ({
        value: val,
        label: this._formatTick(val, yPrefix, ySuffix),
        py: Math.round((plotHeight - ((val - yAxisInfo.min) / yRange) * plotHeight) * 100) / 100,
      })),
      min: yAxisInfo.min,
      max: yAxisInfo.max,
    };

    // X-axis: label positions
    const xAxis = {
      labels: points.map((p) => ({
        label: p.label,
        px: p.px,
      })),
    };

    return { pathD, points, yAxis, xAxis };
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
  radar({ data, maxValue: _maxValue, radius, cx, cy, gridLevels = 5 }) {
    // Auto-derive maxValue from data if not provided
    const maxValue = _maxValue || Math.max(...data.map((d) => d.value));
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
