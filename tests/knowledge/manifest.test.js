const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { BuildManifest } = require('../../src/knowledge/manifest');

const TEST_PATH = path.join(__dirname, 'test-manifest.json');

describe('BuildManifest', () => {
  afterEach(() => { try { fs.unlinkSync(TEST_PATH); } catch {} });

  it('records and finds sections', () => {
    const m = new BuildManifest();
    m.setArtboard('8349:100');
    m.addSection('Header', '8349:101', 'frame');
    m.addSection('Metrics Row', '8349:102', 'frame');
    assert.equal(m.findBySection('header').figmaNodeId, '8349:101');
    assert.equal(m.findBySection('metrics').figmaNodeId, '8349:102');
    assert.equal(m.findBySection('nonexistent'), null);
  });

  it('finds by node ID', () => {
    const m = new BuildManifest();
    m.addSection('Header', '8349:101', 'frame');
    assert.equal(m.findByNodeId('8349:101').htmlSection, 'Header');
    assert.equal(m.findByNodeId('9999:999'), null);
  });

  it('saves and loads', () => {
    const m = new BuildManifest();
    m.setArtboard('8349:100');
    m.addSection('Header', '8349:101', 'component', 'Page Header');
    m.save(TEST_PATH);
    const loaded = new BuildManifest().load(TEST_PATH);
    assert.equal(loaded.artboardId, '8349:100');
    assert.equal(loaded.sections.length, 1);
    assert.equal(loaded.sections[0].componentName, 'Page Header');
  });

  it('load handles missing file gracefully', () => {
    const m = new BuildManifest().load('/tmp/nonexistent-manifest-12345.json');
    assert.equal(m.artboardId, null);
    assert.deepEqual(m.sections, []);
  });

  it('toJSON returns plain object', () => {
    const m = new BuildManifest();
    m.setArtboard('100:1');
    m.addSection('Footer', '100:2', 'frame');
    const json = m.toJSON();
    assert.equal(json.artboardId, '100:1');
    assert.equal(json.sections.length, 1);
    assert.ok(json.createdAt);
  });
});
