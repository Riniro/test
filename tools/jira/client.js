import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';

/**
 * Errors thrown by the Jira client.
 */
class JiraError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'JiraError';
    this.code = code;
  }
}

/**
 * Read credentials from the credentials file.
 *
 * @param {Record<string, string>} env
 * @returns {{ site: string, email: string, token: string }}
 * @throws {JiraError} with code SOURCE_UNAVAILABLE when the file is missing or unreadable.
 */
export function loadCredentials(env) {
  const src = env || process.env;
  let filePath = src.JIRA_CREDENTIALS_FILE;

  if (!filePath) {
    filePath = path.join(os.homedir(), '.jira-coordinator.json');
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EACCES') {
      throw new JiraError('Credentials file not found', 'SOURCE_UNAVAILABLE');
    }
    throw new JiraError('Credentials file unreadable', 'SOURCE_UNAVAILABLE');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new JiraError('Credentials file contains invalid JSON', 'SOURCE_UNAVAILABLE');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new JiraError('Credentials file root must be an object', 'SOURCE_UNAVAILABLE');
  }

  if (typeof parsed.site !== 'string' || parsed.site.length === 0) {
    throw new JiraError('Credentials file must contain a non-empty site field', 'SOURCE_UNAVAILABLE');
  }
  if (typeof parsed.email !== 'string' || parsed.email.length === 0) {
    throw new JiraError('Credentials file must contain a non-empty email field', 'SOURCE_UNAVAILABLE');
  }
  if (typeof parsed.token !== 'string' || parsed.token.length === 0) {
    throw new JiraError('Credentials file must contain a non-empty token field', 'SOURCE_UNAVAILABLE');
  }

  return { site: parsed.site, email: parsed.email, token: parsed.token };
}

/**
 * Helper: build Basic auth header value without exposing the token in errors.
 *
 * @param {string} email
 * @param {string} token
 * @returns {string}
 */
function _authHeader(email, token) {
  const encoded = Buffer.from(`${email}:${token}`).toString('base64');
  return `Basic ${encoded}`;
}

/**
 * Helper: parse a Jira API response and throw structured errors.
 *
 * @param {import('node:http').ClientRequest} _req (unused, kept for future hooks)
 * @param {Response} response
 * @throws {JiraError} with code AUTH_FAILED / NOT_FOUND / SOURCE_UNAVAILABLE.
 */
function _handleResponse(_req, response) {
  if (response.status === 401 || response.status === 403) {
    throw new JiraError('Authentication failed', 'AUTH_FAILED');
  }
  if (response.status === 404) {
    throw new JiraError('Resource not found', 'NOT_FOUND');
  }
  if (!response.ok) {
    throw new JiraError(`API error ${response.status}`, 'SOURCE_UNAVAILABLE');
  }
  return response;
}

/**
 * Helper: make a GET request to Jira.
 *
 * @param {object} opts
 * @param {string} opts.site
 * @param {string} opts.email
 * @param {string} opts.token
 * @param {string} opts.path
 * @param {(url: string, init?: RequestInit) => Promise<Response>} opts.fetchImpl
 * @returns {Promise<unknown>} parsed JSON body
 */
async function _get({ site, email, token, path: endpoint, fetchImpl }) {
  const url = `${site}/rest/api/2${endpoint}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: _authHeader(email, token),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
  } catch {
    throw new JiraError('Network request failed', 'SOURCE_UNAVAILABLE');
  }

  await _handleResponse(null, response);
  return response.json();
}

/**
 * Helper: make a PUT request to Jira.
 *
 * @param {object} opts
 * @param {string} opts.site
 * @param {string} opts.email
 * @param {string} opts.token
 * @param {string} opts.path
 * @param {object} opts.body
 * @param {(url: string, init?: RequestInit) => Promise<Response>} opts.fetchImpl
 * @returns {Promise<unknown>} parsed JSON body
 */
async function _put({ site, email, token, path: endpoint, body, fetchImpl }) {
  const url = `${site}/rest/api/2${endpoint}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'PUT',
      headers: {
        Authorization: _authHeader(email, token),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new JiraError('Network request failed', 'SOURCE_UNAVAILABLE');
  }

  await _handleResponse(null, response);
  return response.json();
}

/**
 * Helper: make a POST request to Jira.
 *
 * @param {object} opts
 * @param {string} opts.site
 * @param {string} opts.email
 * @param {string} opts.token
 * @param {string} opts.path
 * @param {object} opts.body
 * @param {(url: string, init?: RequestInit) => Promise<Response>} opts.fetchImpl
 * @returns {Promise<unknown>} parsed JSON body
 */
async function _post({ site, email, token, path: endpoint, body, fetchImpl }) {
  const url = `${site}/rest/api/2${endpoint}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: _authHeader(email, token),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new JiraError('Network request failed', 'SOURCE_UNAVAILABLE');
  }

  await _handleResponse(null, response);
  return response.json();
}

/**
 * Search for issues by a set of labels within a project.
 * Returns issues sorted by creation date ascending.
 *
 * @param {object} opts
 * @param {string} opts.creds.site
 * @param {string} opts.creds.email
 * @param {string} opts.creds.token
 * @param {string[]} opts.labels — all must be present on the issue.
 * @param {string} opts.project
 * @param {(url: string, init?: RequestInit) => Promise<Response>} [opts.fetchImpl]
 * @returns {Promise<Array<{ key: string, summary: string, status: string, labels: string[] }>>}
 */
export async function searchByLabels({ creds, labels, project, fetchImpl }) {
  const fetcher = fetchImpl || fetch;
  const labelClause = labels.map((l) => `"${l}"`).join(',');
  const jql = `project = "${project}" AND label in (${labelClause}) ORDER BY created ASC`;

  const data = /** @type {{ issues: Array<{ key: string, fields: any }> }} */ (
    await _get({
      site: creds.site,
      email: creds.email,
      token: creds.token,
      path: '/search',
      fetchImpl: fetcher,
    })
  );

  return (data.issues || []).map((issue) => {
    const fields = issue.fields || {};
    return {
      key: issue.key,
      summary: fields.summary || '',
      status: (fields.status && fields.status.name) || '',
      labels: fields.labels || [],
    };
  });
}

/**
 * Get a single issue by key.
 *
 * @param {object} opts
 * @param {string} opts.creds.site
 * @param {string} opts.creds.email
 * @param {string} opts.creds.token
 * @param {string} opts.key
 * @param {(url: string, init?: RequestInit) => Promise<Response>} [opts.fetchImpl]
 * @returns {Promise<{ key: string, summary: string, description: string, status: string, labels: string[] }>}
 */
export async function getIssue({ creds, key, fetchImpl }) {
  const fetcher = fetchImpl || fetch;
  const data = /** @type {{ fields: any }} */ (
    await _get({
      site: creds.site,
      email: creds.email,
      token: creds.token,
      path: `/issue/${encodeURIComponent(key)}`,
      fetchImpl: fetcher,
    })
  );

  const fields = data.fields || {};
  return {
    key,
    summary: fields.summary || '',
    description: fields.description || '',
    status: (fields.status && fields.status.name) || '',
    labels: fields.labels || [],
  };
}

/**
 * Replace labels on an issue.
 *
 * @param {object} opts
 * @param {string} opts.creds.site
 * @param {string} opts.creds.email
 * @param {string} opts.creds.token
 * @param {string} opts.key
 * @param {string[]} opts.labels
 * @param {(url: string, init?: RequestInit) => Promise<Response>} [opts.fetchImpl]
 * @returns {Promise<void>}
 */
export async function setLabels({ creds, key, labels, fetchImpl }) {
  const fetcher = fetchImpl || fetch;
  await _post({
    site: creds.site,
    email: creds.email,
    token: creds.token,
    path: `/issue/${encodeURIComponent(key)}`,
    body: { fields: { labels } },
    fetchImpl: fetcher,
  });
}

/**
 * Perform a transition on an issue.
 *
 * @param {object} opts
 * @param {string} opts.creds.site
 * @param {string} opts.creds.email
 * @param {string} opts.creds.token
 * @param {string} opts.key
 * @param {string|number} opts.transitionId
 * @param {(url: string, init?: RequestInit) => Promise<Response>} [opts.fetchImpl]
 * @returns {Promise<void>}
 */
export async function transition({ creds, key, transitionId, fetchImpl }) {
  const fetcher = fetchImpl || fetch;
  await _post({
    site: creds.site,
    email: creds.email,
    token: creds.token,
    path: `/issue/${encodeURIComponent(key)}/transitions`,
    body: { transition: { id: String(transitionId) } },
    fetchImpl: fetcher,
  });
}

/**
 * Add a comment to an issue.
 *
 * @param {object} opts
 * @param {string} opts.creds.site
 * @param {string} opts.creds.email
 * @param {string} opts.creds.token
 * @param {string} opts.key
 * @param {string} opts.body
 * @param {(url: string, init?: RequestInit) => Promise<Response>} [opts.fetchImpl]
 * @returns {Promise<void>}
 */
export async function addComment({ creds, key, body, fetchImpl }) {
  const fetcher = fetchImpl || fetch;
  await _post({
    site: creds.site,
    email: creds.email,
    token: creds.token,
    path: `/issue/${encodeURIComponent(key)}/comment`,
    body: { body },
    fetchImpl: fetcher,
  });
}

export { JiraError };
