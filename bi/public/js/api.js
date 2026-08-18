let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 401) {
    onUnauthorized();
    throw new Error('Sign in required');
  }

  const type = response.headers.get('Content-Type') || '';
  if (!type.includes('application/json')) {
    if (!response.ok) throw new Error(`The server answered ${response.status}`);
    return response;
  }

  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `The server answered ${response.status}`);
    error.detail = data.detail;
    throw error;
  }
  return data;
}
