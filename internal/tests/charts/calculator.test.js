const { describe, it } = require('node:test');
const assert = require('node:assert');
const { ChartCalculator } = require('../../../src/charts/calculator');

const calc = new ChartCalculator();

describe('ChartCalculator', () => {
  describe('bar', () => {
    it('scales bar heights proportionally', () => {
      const result = calc.bar({
        data: [{ label: 'A', value: 50 }, { label: 'B', value: 100 }],
        chartHeight: 200,
      });
      assert.equal(result.bars[0].height, 100);
      assert.equal(result.bars[1].height, 200);
    });

    it('handles zero values', () => {
      const result = calc.bar({
        data: [{ label: 'A', value: 0 }, { label: 'B', value: 100 }],
        chartHeight: 200,
      });
      assert.equal(result.bars[0].height, 0);
      assert.equal(result.bars[1].height, 200);
    });
  });

  describe('donut', () => {
    it('segments span exactly 2*PI', () => {
      const result = calc.donut({
        data: [{ label: 'A', value: 30 }, { label: 'B', value: 70 }],
        outerRadius: 100,
        innerRadius: 0.65,
      });
      const first = result.segments[0];
      const last = result.segments[result.segments.length - 1];
      const totalSweep = last.endAngle - first.startAngle;
      assert.ok(Math.abs(totalSweep - Math.PI * 2) < 0.0001);
    });

    it('each segment starts where previous ended', () => {
      const result = calc.donut({
        data: [{ label: 'A', value: 25 }, { label: 'B', value: 25 }, { label: 'C', value: 50 }],
        outerRadius: 100,
        innerRadius: 0.65,
      });
      assert.ok(Math.abs(result.segments[1].startAngle - result.segments[0].endAngle) < 0.0001);
      assert.ok(Math.abs(result.segments[2].startAngle - result.segments[1].endAngle) < 0.0001);
    });

    it('handles single segment (100%)', () => {
      const result = calc.donut({
        data: [{ label: 'Only', value: 100 }],
        outerRadius: 100,
        innerRadius: 0.65,
      });
      assert.equal(result.segments.length, 1);
      const sweep = result.segments[0].endAngle - result.segments[0].startAngle;
      assert.ok(Math.abs(sweep - Math.PI * 2) < 0.0001);
    });
  });

  describe('line', () => {
    it('generates valid SVG path string starting with M', () => {
      const result = calc.line({
        data: [{ x: 0, y: 10 }, { x: 50, y: 40 }, { x: 100, y: 20 }],
        plotWidth: 300,
        plotHeight: 200,
      });
      assert.ok(result.pathD.startsWith('M'));
    });

    it('returns data point positions for dots', () => {
      const result = calc.line({
        data: [{ x: 0, y: 10 }, { x: 100, y: 50 }],
        plotWidth: 300,
        plotHeight: 200,
      });
      assert.equal(result.points.length, 2);
      assert.ok(result.points[0].px !== undefined);
      assert.ok(result.points[0].py !== undefined);
    });
  });

  describe('radar', () => {
    it('computes correct number of vertices', () => {
      const result = calc.radar({
        data: [{ label: 'Speed', value: 80 }, { label: 'Power', value: 60 }, { label: 'Range', value: 90 }],
        maxValue: 100, radius: 120, cx: 150, cy: 150,
      });
      assert.equal(result.vertices.length, 3);
    });

    it('generates grid SVG with polygon or line elements', () => {
      const result = calc.radar({
        data: [{ label: 'A', value: 50 }, { label: 'B', value: 50 }, { label: 'C', value: 50 }],
        maxValue: 100, radius: 100, cx: 100, cy: 100,
      });
      assert.ok(result.gridSvg.includes('<polygon') || result.gridSvg.includes('<line'));
    });
  });

  describe('scatter', () => {
    it('normalizes points to plot area', () => {
      const result = calc.scatter({
        data: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
        plotWidth: 300, plotHeight: 200,
      });
      assert.equal(result.points[0].px, 0);
      assert.equal(result.points[0].py, 200);
      assert.equal(result.points[1].px, 300);
      assert.equal(result.points[1].py, 0);
    });
  });

  describe('heatmap', () => {
    it('calculates intensity from 0 to 1', () => {
      const result = calc.heatmap({
        data: [{ row: 0, col: 0, value: 50 }, { row: 0, col: 1, value: 100 }],
        cellWidth: 40, cellHeight: 40,
      });
      assert.equal(result.cells[0].intensity, 0.5);
      assert.equal(result.cells[1].intensity, 1);
    });
  });
});
