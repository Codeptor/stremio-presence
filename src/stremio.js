import { getAuthKey } from "./auth.js";

const API_BASE = "https://api.strem.io";
const COLLECTION = "libraryItem";

const AUTH_ERROR_PATTERN = /\b(auth|session|key|unauthor|token)\b/i;

async function callApi(path, buildBody) {
  let authKey = await getAuthKey();
  let refreshed = false;

  while (true) {
    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildBody(authKey)),
        signal: AbortSignal.timeout(10000),
      });
    } catch (cause) {
      throw new Error(`Stremio API network error on ${path}: ${cause.message}`, { cause });
    }

    const text = await response.text();
    let payload;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch (cause) {
        throw new Error(
          `Stremio API returned non-JSON on ${path} (HTTP ${response.status}): ${text.slice(0, 200)}`,
          { cause },
        );
      }
    }

    const jsonErrorMessage =
      payload && typeof payload === "object" && payload.error
        ? typeof payload.error === "string"
          ? payload.error
          : payload.error.message || JSON.stringify(payload.error)
        : null;

    const isAuthHttp = response.status === 401 || response.status === 403;
    const isAuthJsonError = jsonErrorMessage != null && AUTH_ERROR_PATTERN.test(jsonErrorMessage);

    if ((isAuthHttp || isAuthJsonError) && !refreshed) {
      refreshed = true;
      authKey = await getAuthKey({ forceRefresh: true });
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `Stremio API ${path} failed (HTTP ${response.status})${jsonErrorMessage ? `: ${jsonErrorMessage}` : ""}`,
      );
    }

    if (jsonErrorMessage) {
      throw new Error(`Stremio API ${path} returned an error: ${jsonErrorMessage}`);
    }

    if (!payload || payload.result === undefined) {
      throw new Error(`Stremio API ${path} returned no result field.`);
    }

    return payload.result;
  }
}

export async function datastoreMeta() {
  const result = await callApi("/api/datastoreMeta", (authKey) => ({
    authKey,
    collection: COLLECTION,
  }));

  if (!Array.isArray(result)) {
    throw new Error("datastoreMeta: expected result to be an array of [id, mtimeMs] pairs.");
  }
  return result;
}

export async function datastoreGet(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("datastoreGet: ids must be a non-empty array.");
  }

  const result = await callApi("/api/datastoreGet", (authKey) => ({
    authKey,
    collection: COLLECTION,
    all: false,
    ids,
  }));

  if (!Array.isArray(result)) {
    throw new Error("datastoreGet: expected result to be an array of LibraryItem objects.");
  }
  return result;
}
