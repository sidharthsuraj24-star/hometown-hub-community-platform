'use strict';

const { Readable } = require('node:stream');
const { isIP } = require('node:net');

function toNodeRequest(request) {
  const url = new URL(request.url);
  const headers = Object.fromEntries(request.headers.entries());
  if (!headers.host) headers.host = url.host;
  // Vercel overwrites X-Forwarded-For to prevent spoofing; use its dedicated
  // platform header instead of request-controlled generic forwarding headers.
  const forwarded = headers['x-vercel-forwarded-for'] || '';
  const candidateIp = forwarded.split(',')[0].trim();
  const remoteAddress = isIP(candidateIp) ? candidateIp : 'unknown';
  const stream = request.body ? Readable.fromWeb(request.body) : Readable.from([]);
  stream.method = request.method;
  stream.url = `${url.pathname}${url.search}`;
  stream.headers = headers;
  stream.socket = { remoteAddress };
  return stream;
}

function createNodeResponse() {
  let statusCode = 200;
  let responseHeaders = new Headers();
  let responseBody = Buffer.alloc(0);
  let headersSent = false;
  let destroyed = false;
  return {
    get statusCode() { return statusCode; },
    get headers() { return responseHeaders; },
    get body() { return responseBody; },
    get headersSent() { return headersSent; },
    get destroyed() { return destroyed; },
    writeHead(status, headers = {}) {
      statusCode = status;
      responseHeaders = new Headers(headers);
      headersSent = true;
      return this;
    },
    end(chunk) {
      if (chunk === undefined || chunk === null) responseBody = Buffer.alloc(0);
      else if (Buffer.isBuffer(chunk)) responseBody = chunk;
      else if (ArrayBuffer.isView(chunk)) responseBody = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      else responseBody = Buffer.from(String(chunk));
      return this;
    },
    destroy() {
      destroyed = true;
      headersSent = true;
    }
  };
}

function createFetchHandler(getApp) {
  return async function fetchHandler(request) {
    const response = createNodeResponse();
    await getApp().handle(toNodeRequest(request), response);
    if (response.destroyed) return new Response(null, { status: 500, headers: response.headers });
    const body = request.method === 'HEAD' || response.statusCode === 204 || response.statusCode === 304 ? null : response.body;
    return new Response(body, { status: response.statusCode, headers: response.headers });
  };
}

module.exports = { createFetchHandler };
