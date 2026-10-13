/**
 * Shared sign-in helper for the verification scripts.
 *
 * Every data endpoint is behind a session now, so a script that only speaks HTTP
 * needs a cookie and a script that drives the browser needs that same cookie
 * planted in it before the app boots.
 */
import { adminPassword, adminUsername } from "./credentials.mjs";

const DEFAULT_BASE = process.env.API_BASE ?? "http://127.0.0.1:5000";

/** Signs in and returns the cookies as `name=value` pairs. */
export async function signIn(
  base = DEFAULT_BASE,
  username = adminUsername,
  password = adminPassword,
) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // The API allows credentials only for known origins, so a request without
      // an Origin gets no `Access-Control-Allow-Credentials` and its Set-Cookie
      // headers cannot be read.
      origin: new URL(base).origin,
    },
    body: JSON.stringify({ username, password }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Could not sign in as ${username}: ${response.status} ${body.slice(0, 200)}`,
    );
  }

  const cookies = (response.headers.getSetCookie?.() ?? []).map((entry) => {
    const [pair] = entry.split(";");
    const index = pair.indexOf("=");
    return { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim() };
  });

  return { cookies, cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
}

/**
 * Plants the session cookie into the browser under test.
 *
 * `Network.setCookie` is used rather than `document.cookie` because the session
 * cookie is httpOnly — the page itself must not be able to read or write it.
 * A full URL is passed rather than a bare domain, otherwise the cookie can end
 * up attached to the wrong port when the app runs somewhere other than the API.
 */
export async function setBrowserCookies(cdp, base, cookies) {
  const origin = new URL(base).origin;
  for (const cookie of cookies) {
    const result = await cdp.send("Network.setCookie", {
      name: cookie.name,
      value: cookie.value,
      url: origin,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    });
    if (!result?.success) {
      throw new Error(`Could not set the ${cookie.name} cookie for ${origin}`);
    }
  }
}

/** Convenience wrapper: sign in and plant the cookies in one call. */
export async function signInBrowser(cdp, base = DEFAULT_BASE) {
  const session = await signIn(DEFAULT_BASE);
  await setBrowserCookies(cdp, base, session.cookies);
  return session;
}
