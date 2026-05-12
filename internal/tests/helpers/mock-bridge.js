'use strict';

/**
 * Mock Bridge that records messages instead of sending them over WebSocket.
 * Drop-in replacement for the real Bridge during tests.
 */
class MockBridge {
  constructor() {
    this.connected = true;
    this.messages = [];
    this.responses = {};
    this._counter = 0;
  }

  /**
   * Record what was sent and return a canned response.
   * @param {string} type - Bridge handler name
   * @param {object} payload - Handler parameters
   * @param {number} [timeout] - Ignored in mock
   * @returns {object} Canned response
   */
  async send(type, payload, timeout) {
    this.messages.push({ type, payload });

    // Return canned response if configured
    if (this.responses[type]) {
      const response = this.responses[type];
      return typeof response === 'function' ? response(payload) : response;
    }

    // Default responses for common handlers
    const defaults = {
      'get_plugin_status': {
        fileName: 'Test File',
        currentPage: { name: 'Page 1' },
        enforcementProfile: {
          enforceTextStyles: false,
          enforceColorVars: false,
          enforceSpacingVars: false,
          enforceRadiusVars: false,
        },
        styleCacheSize: 0,
        variableCacheSize: 0,
      },
      'create_frame': {
        nodeId: 'mock:' + (++this._counter),
        name: payload?.name || 'Frame',
        type: 'FRAME',
        applied: {},
        warnings: [],
        bindingFailures: false,
      },
      'create_text': {
        nodeId: 'mock:' + (++this._counter),
        name: payload?.name || 'Text',
        type: 'TEXT',
        characters: payload?.content || '',
        textStyleName: null,
        applied: {},
        warnings: [],
        bindingFailures: false,
      },
      'create_rectangle': {
        nodeId: 'mock:' + (++this._counter),
        name: payload?.name || 'Rectangle',
        type: 'RECTANGLE',
        applied: {},
        warnings: [],
        bindingFailures: false,
      },
      'create_ellipse': {
        nodeId: 'mock:' + (++this._counter),
        name: payload?.name || 'Ellipse',
        type: 'ELLIPSE',
        applied: {},
        warnings: [],
        bindingFailures: false,
      },
      'create_svg': {
        nodeId: 'mock:' + (++this._counter),
        name: payload?.name || 'SVG',
        type: 'VECTOR',
        applied: {},
        warnings: [],
        bindingFailures: false,
      },
      'insert_component': {
        nodeId: 'mock:' + (++this._counter),
        name: payload?.name || 'Component',
        type: 'INSTANCE',
        componentKey: payload?.componentKey,
        componentName: 'Button',
        defaultTexts: ['Button'],
        textNodeNames: ['Label'],
        booleanProperties: { 'Icon leading': true },
        message: 'Inserted Button. Override ALL text.',
      },
      'set_session_defaults': {
        enforcementProfile: payload?.enforcementProfile || {},
        cachedStyles: 0,
      },
      'preload_styles': {
        preloadedStyles: payload?.styleKeys?.length || 0,
        styleCacheSize: 0,
        styles: [],
      },
      'preload_variables': {
        preloadedVars: payload?.variables?.length || 0,
        variableCacheSize: 0,
      },
      'get_pages': { pages: [{ id: 'page:1', name: 'Page 1' }] },
      'change_page': { pageId: 'page:1', pageName: 'Page 1' },
      'get_page_nodes': { pageId: 'page:1', pageName: 'Page 1', nodes: [] },
      'get_node_props': {
        id: payload?.nodeId,
        name: 'Node',
        type: 'FRAME',
        width: 100,
        height: 50,
      },
      'get_node_children': { id: payload?.nodeId, children: [] },
      'get_node_parent': { id: payload?.nodeId, parentId: 'parent:1', parentName: 'Parent' },
      'set_component_text': { nodeId: payload?.nodeId, applied: true },
      'set_component_text_by_id': {
        nodeId: payload?.textNodeId,
        parentNodeId: payload?.nodeId,
        name: 'Text',
        type: 'TEXT',
        characters: payload?.content || payload?.characters || '',
        applied: {},
        warnings: [],
        bindingFailures: false,
      },
      'set_variant': { nodeId: payload?.nodeId, applied: {} },
      'swap_main_component': { nodeId: payload?.nodeId, swapped: true },
      'replace_component': { nodeId: 'mock:' + (++this._counter), replaced: true },
      'set_text': { nodeId: payload?.nodeId, applied: true },
      'set_node_fill': { nodeId: payload?.nodeId, applied: true },
      'set_layout_sizing': { nodeId: payload?.nodeId, applied: true },
      'set_visibility': { nodeId: payload?.nodeId, visible: payload?.visible },
      'set_variable_mode': { nodeId: payload?.nodeId, applied: true },
      'set_text_style': { nodeId: payload?.nodeId, applied: true },
      'move_node': { nodeId: payload?.nodeId, moved: true },
      'set_node_position': { nodeId: payload?.nodeId, x: payload?.x, y: payload?.y },
      'delete_node': { deleted: true },
      'restyle_artboard': { nodeId: payload?.nodeId, applied: true },
      'get_component_variants': { variants: [] },
      'get_text_info': { nodeId: payload?.nodeId, content: '', style: {} },
      'get_selection': { selection: [] },
      'select_node': { nodeId: payload?.nodeId, selected: true },
      'validate_ds_compliance': {
        violations: [],
        summary: { totalNodes: 10, compliant: 10, violations: 0 },
      },
      'discover_library_styles': { styles: [], totalStyles: 0, hint: 'No styles found.' },
      'discover_library_variables': { libraries: [], variables: [], totalCollections: 0, totalVariables: 0 },
    };

    return defaults[type] || { ok: true };
  }

  /** Configure a canned response for a specific message type. */
  setResponse(type, response) {
    this.responses[type] = response;
  }

  /** Get all messages sent for a given type. */
  getMessages(type) {
    return this.messages.filter(m => m.type === type);
  }

  /** Get the last message sent. */
  get lastMessage() {
    return this.messages[this.messages.length - 1];
  }

  /** Reset all recorded messages and canned responses. */
  reset() {
    this.messages = [];
    this.responses = {};
    this._counter = 0;
  }

  // Bridge interface compatibility
  async start() {}
  async stop() {}
}

module.exports = { MockBridge };
