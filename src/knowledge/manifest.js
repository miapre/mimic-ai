'use strict';

const fs = require('node:fs');
const path = require('node:path');

class BuildManifest {
  constructor() {
    this.artboardId = null;
    this.sections = [];  // { htmlSection, figmaNodeId, type, componentName? }
    this.createdAt = null;
  }

  setArtboard(nodeId) {
    this.artboardId = nodeId;
    this.createdAt = new Date().toISOString();
  }

  addSection(htmlSection, figmaNodeId, type, componentName) {
    this.sections.push({
      htmlSection,
      figmaNodeId,
      type,  // 'component' | 'primitive' | 'frame'
      componentName: componentName || null,
    });
  }

  findBySection(sectionName) {
    const lower = sectionName.toLowerCase();
    return this.sections.find(s =>
      s.htmlSection.toLowerCase().includes(lower)
    ) || null;
  }

  findByNodeId(nodeId) {
    return this.sections.find(s => s.figmaNodeId === nodeId) || null;
  }

  toJSON() {
    return {
      artboardId: this.artboardId,
      createdAt: this.createdAt,
      sections: this.sections,
    };
  }

  save(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(this.toJSON(), null, 2));
  }

  load(filePath) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      this.artboardId = data.artboardId;
      this.createdAt = data.createdAt;
      this.sections = data.sections || [];
    } catch {} // File doesn't exist — fresh manifest
    return this;
  }
}

module.exports = { BuildManifest };
