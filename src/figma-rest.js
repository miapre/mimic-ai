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
            reject(new Error('FIGMA_ACCESS_DENIED: No access to this file. The token owner needs at least Viewer access to the file. If the token is new, verify it has all 5 required scopes: current_user:read, file_content:read, file_metadata:read, library_assets:read, library_content:read. Generate at: Figma → Avatar → Settings → Security → Personal access tokens.'));
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

  /**
   * Cheap freshness probe for the REST update-detection fast path
   * (schema-v3-spec.md §4.2). Figma's REST API has no dedicated
   * "published-variables updatedAt" endpoint distinct from full file data,
   * so `version` + `lastModified` from a depth-1 (metadata-only, no deep
   * node tree) file fetch serve as the freshness proxy: both change
   * whenever anything in the file — including its published components,
   * styles, or variables — changes. Far cheaper than re-fetching the full
   * component/style lists on every discovery call.
   */
  async getFileFreshness(fileKey) {
    const raw = await this._get(`/files/${fileKey}?depth=1`);
    return { version: raw?.version ?? null, lastModified: raw?.lastModified ?? null };
  }

  /**
   * Get all published (team-library) components from a file.
   * `page_size=1000` is passed explicitly — Figma raised the team/library
   * components pagination cap to 1000 (platform update, 2026); the
   * per-file /components endpoint has historically returned its full,
   * unpaginated list regardless of this param, so pinning it is a
   * forward-compatible no-op today rather than a behavior change, and
   * avoids silently falling back to a smaller implicit default page if
   * Figma ever applies the team-components pagination model here too.
   */
  async getFileComponents(fileKey) {
    const raw = await this._get(`/files/${fileKey}/components?page_size=1000`);
    return this.parseComponentsResponse(raw);
  }

  /** Get all published styles from a file (filtered to TEXT) */
  async getFileTextStyles(fileKey) {
    const raw = await this._get(`/files/${fileKey}/styles`);
    return this.parseStylesResponse(raw);
  }

  /** Get all published FILL styles (color styles) from a file */
  async getFileFillStyles(fileKey) {
    const raw = await this._get(`/files/${fileKey}/styles`);
    return this.parseFillStylesResponse(raw);
  }

  /** Get all published styles from a file (all types) */
  async getAllStyles(fileKey) {
    const raw = await this._get(`/files/${fileKey}/styles`);
    return {
      textStyles: this.parseStylesResponse(raw),
      fillStyles: this.parseFillStylesResponse(raw),
      effectStyles: this.parseEffectStylesResponse(raw),
    };
  }

  /**
   * Resolve the library file key that a published component/style key lives
   * in. Figma's /component_sets/{key}, /components/{key} and /styles/{key}
   * responses all carry meta.file_key. This lets discovery find a library's
   * file key automatically from any published key already present on the page,
   * so a single-library file never has to prompt for it. Returns null when the
   * key can't be resolved (deleted, inaccessible, or local/non-published).
   */
  async resolveLibraryFileKey(publishedKey) {
    if (!publishedKey) return null;
    const endpoints = [
      `/component_sets/${publishedKey}`,
      `/components/${publishedKey}`,
      `/styles/${publishedKey}`,
    ];
    for (const ep of endpoints) {
      try {
        const raw = await this._get(ep);
        const fk = raw && raw.meta && raw.meta.file_key;
        if (fk) return fk;
      } catch (e) { /* try the next endpoint */ }
    }
    return null;
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

  /** Parse the /styles response, keeping only FILL styles */
  parseFillStylesResponse(raw) {
    const styles = raw?.meta?.styles;
    if (!Array.isArray(styles)) return [];
    return styles
      .filter(s => s.style_type === 'FILL')
      .map(s => ({
        key: s.key,
        name: s.name,
        description: s.description || '',
      }));
  }

  /** Parse the /styles response, keeping only EFFECT styles */
  parseEffectStylesResponse(raw) {
    const styles = raw?.meta?.styles;
    if (!Array.isArray(styles)) return [];
    return styles
      .filter(s => s.style_type === 'EFFECT')
      .map(s => ({
        key: s.key,
        name: s.name,
        description: s.description || '',
      }));
  }
}

module.exports = { FigmaRest };
