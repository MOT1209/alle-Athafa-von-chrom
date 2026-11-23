/**
 * Test-only fetch adapter built on node:http.
 *
 * Node's global fetch (undici) gives up on a response when the server takes
 * several minutes to send headers. Ollama sends nothing until prompt
 * evaluation finishes, so a summary call on slow CPU hardware can legitimately
 * wait ~10 minutes for headers. Chrome's fetch has no such ceiling, and the
 * extension runs in Chrome; this adapter lets the Node live test exercise the
 * same product code without imposing a transport limit the browser does not
 * have. It is never imported by the extension.
 */
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function requestUrl(input: FetchInput): URL {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

function requestHeaders(init: FetchInit): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
  if (!init?.headers) return result;
  new Headers(init.headers).forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function requestBody(init: FetchInit): string | undefined {
  if (init?.body === undefined || init.body === null) return undefined;
  if (typeof init.body === 'string') return init.body;
  throw new Error('nodeFetch test adapter only supports string bodies');
}

export const nodeFetch: typeof fetch = (input, init) =>
  new Promise<Response>((resolve, reject) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    const body = requestBody(init);
    const signal = init?.signal ?? undefined;

    if (signal?.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }

    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(
      url,
      { method, headers: requestHeaders(init) },
      (response) => {
        const stream = Readable.toWeb(response);
        response.on('close', () =>
          signal?.removeEventListener('abort', abort),
        );
        resolve(
          new Response(stream as ReadableStream<Uint8Array>, {
            status: response.statusCode ?? 502,
            statusText: response.statusMessage,
            headers: response.headers as Record<string, string>,
          }),
        );
      },
    );

    const abort = () => {
      request.destroy(new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });

    request.on('error', (error) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      reject(error);
    });

    if (body !== undefined) request.write(body);
    request.end();
  });
