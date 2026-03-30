const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";

let unauthorizedHandler = null;

function readFileNameFromDisposition(headerValue) {
  const value = String(headerValue || "");
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1]);
  }

  const simpleMatch = value.match(/filename="?([^"]+)"?/i);
  return simpleMatch?.[1] || "";
}

async function request(path, { token, headers = {}, body, method = "GET", raw = false } = {}) {
  const hasJsonBody = body != null && !(body instanceof FormData);

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(hasJsonBody ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body:
      body == null
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body)
  });

  if (response.status === 401 && unauthorizedHandler) {
    unauthorizedHandler();
  }

  if (!response.ok) {
    let message = "Falha na requisicao.";
    try {
      const payload = await response.json();
      message = payload.message || message;
    } catch (error) {
      message = response.statusText || message;
    }
    throw new Error(message);
  }

  if (raw) {
    return response;
  }

  return response.status === 204 ? null : response.json();
}

export function apiJson(path, { token, method = "GET", data } = {}) {
  return request(path, {
    token,
    method,
    body: data
  });
}

export function apiFormData(path, { token, method = "POST", data } = {}) {
  return request(path, {
    token,
    method,
    body: data
  });
}

export async function downloadFile(path, { token, fileName } = {}) {
  const response = await request(path, {
    token,
    raw: true
  });

  const blob = await response.blob();
  const downloadUrl = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = downloadUrl;
  anchor.download = fileName || readFileNameFromDisposition(response.headers.get("content-disposition")) || "download";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(downloadUrl);
}

export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = handler;
}
