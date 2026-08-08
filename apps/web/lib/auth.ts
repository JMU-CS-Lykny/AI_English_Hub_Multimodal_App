import type { User } from "./types";

const TOKEN_KEY = "accessToken";
const USER_KEY = "user";
export const AUTH_USER_CHANGED_EVENT = "auth-user-changed";

function emitUserChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(AUTH_USER_CHANGED_EVENT));
}

export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser(): User | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export function setAuth(accessToken: string, user: User): void {
  localStorage.setItem(TOKEN_KEY, accessToken);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  emitUserChanged();
}

/** Refresh stored session user after profile update (keeps access token). */
export function setStoredUser(user: User): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  emitUserChanged();
}

export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  emitUserChanged();
}

export function isAuthenticated(): boolean {
  return !!getAccessToken() && !!getUser();
}
