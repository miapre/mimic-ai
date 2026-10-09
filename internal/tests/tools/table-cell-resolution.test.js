'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../../../src/tools/table');
const { insertTextNodes, insertVariantProps, resolveStyleVariant, findPropName, collectTextNodes } = _internal;

describe('mimic_build_table — DS-agnostic cell resolution helpers', () => {
  it('reads textNodes/variantProperties from both raw and configurationHints shapes', () => {
    const raw = { textNodes: [{ nodeId: 'a', name: 'Label' }], variantProperties: { Type: { values: ['x'] } } };
    const wrapped = { configurationHints: { textNodes: [{ nodeId: 'b', name: 'Title' }], variantProperties: { Kind: { values: ['y'] } } } };
    assert.deepEqual(insertTextNodes(raw), [{ id: 'a', name: 'Label' }]);
    assert.deepEqual(insertTextNodes(wrapped), [{ id: 'b', name: 'Title' }]);
    assert.ok(insertVariantProps(raw).Type);
    assert.ok(insertVariantProps(wrapped).Kind);
    assert.deepEqual(insertTextNodes({}), []);
    assert.deepEqual(insertVariantProps({}), {});
  });

  it('resolveStyleVariant finds the owning property + exact value regardless of property name', () => {
    // This DS names the style property "Cell type" (not "Style"), with cased values.
    const vprops = {
      'Cell type': { values: ['Text', 'Lead text', 'Badge', 'Progress bar'], current: 'Progress bar' },
      'Supporting text': { values: ['True', 'False'], current: 'False' },
    };
    assert.deepEqual(resolveStyleVariant(vprops, 'lead text'), { prop: 'Cell type', value: 'Lead text' });
    assert.deepEqual(resolveStyleVariant(vprops, 'Badge'), { prop: 'Cell type', value: 'Badge' });
    assert.equal(resolveStyleVariant(vprops, 'avatar'), null, 'no matching value → null (caller reports a gap)');
    assert.equal(resolveStyleVariant({}, 'Text'), null);
  });

  it('findPropName locates the supporting-text property by pattern', () => {
    assert.equal(findPropName({ 'Supporting text': {} }, /supporting[\s-]*text/i), 'Supporting text');
    assert.equal(findPropName({ 'Show supporting-text': {} }, /supporting[\s-]*text/i), 'Show supporting-text');
    assert.equal(findPropName({ Size: {} }, /supporting[\s-]*text/i), null);
  });

  it('collectTextNodes walks nested get_node_children and keeps only visible TEXT nodes, in order', () => {
    const children = [
      { id: '1', name: 'Icon', type: 'FRAME', children: [{ id: '2', name: 'Vector', type: 'VECTOR' }] },
      { id: '3', name: 'Body', type: 'FRAME', children: [
        { id: '4', name: 'Title', type: 'TEXT', visible: true },
        { id: '5', name: 'Subtitle', type: 'TEXT', visible: true },
        { id: '6', name: 'Hidden', type: 'TEXT', visible: false },
      ] },
    ];
    const out = collectTextNodes(children, []);
    assert.deepEqual(out, [{ id: '4', name: 'Title' }, { id: '5', name: 'Subtitle' }], 'ordered, visible-only');
  });
});
