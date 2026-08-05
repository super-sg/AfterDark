// Thin fetch wrapper. Every non-2xx response becomes an ApiError carrying the
// server's message so views can render it verbatim.

export class ApiError extends Error {
  constructor(message, status, payload = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }

  get ageRequired() {
    return this.payload?.ageRequired === true;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError('Network unavailable. Check your connection.', 0);
  }

  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError('The server returned something unreadable.', res.status);
    }
  }

  if (!res.ok) {
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body ?? {}),
  patch: (path, body) => request('PATCH', path, body ?? {}),
  del: (path) => request('DELETE', path),
};

export const query = (params) => {
  const usable = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return usable.length ? `?${new URLSearchParams(usable)}` : '';
};
