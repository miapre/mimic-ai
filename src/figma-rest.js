'use strict';

const https = require('node:https');

class FigmaRest {
  constructor(token) {
    if (!token) throw new Error('Figma token is required. Set FIGMA_TOKEN in your MCP server config.');
    this.token = token;
    this.baseUrl = 'api.figma.com';
  }

  /** Raw GET request to Figma API. Returns parsed JSON. */
  _get(path) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.baseUrl,
        path: `/v1${path}`,
        method: 'GET',
        headers: {
          'X-Figma-Token': this.token,
          'Accept': 'application/json',
        },
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 403) {
            reject(new Error('FIGMA_ACCESS_DENIED: No access to this file. Make sure the token owner has at least Viewer access to the library.'));
          } else if (res.statusCode === 404) {
            reject(new Error('FIGMA_NOT_FOUND: File not found. Check the file key — it\'s the part between /design/ and the next / in the URL.'));
          } else if (res.statusCode === 401) {
            reject(new Error('FIGMA_TOKEN_INVALID: Token rejected by Figma. Check that FIGMA_TOKEN contains the full token (starts with "figd_"). If expired, generate a new one: Figma → Settings → Security → Personal access tokens. Required scopes: current_user:read, file_content:read, file_metadata:read, library_assets:read, library_content:read.'));
          } else if (res.statusCode >= 400) {
            reject(new Error(`FIGMA_API_ERROR: Figma API returned ${res.statusCode}. ${data.slice(0, 200)}`));
          } else {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error('FIGMA_PARSE_ERROR: Invalid response from Figma API.')); }
          }
        });
      });
      req.on('error', (e) => {
        reject(new Error(`FIGMA_NETWORK_ERROR: Can't reach Figma's API. Check your internet connection. (${e.message})`));
      });
      req.end();
    });
  }

  /** Validate token by calling GET /v1/me */
  async validateToken() {
    return this._get('/me');
  }

  /** Validate access to a file (lightweight — depth=0, no node tree) */
  async validateFileAccess(fileKey) {
    return this._get(`/files/${fileKey}?depth=0`);
  }

  /** Get all published components from a file */
  async getFileComponents(fileKey) {
    const raw = await this._get(`/files/${fileKey}/components`);
    return this.parseComponentsResponse(raw);
  }

  /** Get all published styles from a file (filtered to TEXT) */
  async getFileTextStyles(fileKey) {
    const raw = await this._get(`/files/${fileKey}/styles`);
    return this.parseStylesResponse(raw);
  }

  /** Parse the /components response into a flat array */
  parseComponentsResponse(raw) {
    const components = raw?.meta?.components;
    if (!Array.isArray(components)) return [];
    return components.map(c => ({
      key: c.key,
      name: c.name,
      description: c.description || '',
      containingFrame: c.containing_frame?.name || '',
    }));
  }

  /** Parse the /styles response, keeping only TEXT styles */
  parseStylesResponse(raw) {
    const styles = raw?.meta?.styles;
    if (!Array.isArray(styles)) return [];
    return styles
      .filter(s => s.style_type === 'TEXT')
      .map(s => ({
        key: s.key,
        name: s.name,
        description: s.description || '',
      }));
  }
}

module.exports = { FigmaRest };
