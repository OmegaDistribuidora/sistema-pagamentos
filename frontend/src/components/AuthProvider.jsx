import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { apiJson, setUnauthorizedHandler } from "../services/api";

const STORAGE_KEY = "sistema-pagamentos-auth";
const AuthContext = createContext(null);

function parseTokenExpiration(token) {
  try {
    const [, payload] = String(token || "").split(".");
    if (!payload) {
      return null;
    }

    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(padded));
    return typeof parsed.exp === "number" ? parsed.exp * 1000 : null;
  } catch (error) {
    return null;
  }
}

function readStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { token: null, user: null };
  } catch (error) {
    return { token: null, user: null };
  }
}

function readSsoTokenFromHash() {
  try {
    const hash = String(window.location.hash || "").replace(/^#/, "");
    if (!hash) return null;
    const params = new URLSearchParams(hash);
    return params.get("sso");
  } catch (error) {
    return null;
  }
}

function clearSsoHash() {
  const { pathname, search } = window.location;
  window.history.replaceState(null, "", `${pathname}${search}`);
}

export function AuthProvider({ children }) {
  const initial = readStorage();
  const initialSsoToken = readSsoTokenFromHash();
  const initialExpiry = parseTokenExpiration(initial.token);
  const hasInitialExpired = Boolean(initialExpiry && initialExpiry <= Date.now());
  const shouldPreferSso = Boolean(initialSsoToken);
  const [token, setToken] = useState(shouldPreferSso || hasInitialExpired ? null : initial.token || null);
  const [user, setUser] = useState(shouldPreferSso || hasInitialExpired ? null : initial.user || null);
  const [loading, setLoading] = useState(Boolean(initialSsoToken || initial.token));
  const [ssoError, setSsoError] = useState("");
  const [appConfig, setAppConfig] = useState({
    systemName: "Sistema de Pagamentos",
    allowLocalLogin: true,
    ssoEnabled: false
  });
  const [configLoaded, setConfigLoaded] = useState(false);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, user }));
  }, [token, user]);

  useEffect(() => {
    apiJson("/public/app-config")
      .then((payload) => {
        setAppConfig(payload);
      })
      .finally(() => {
        setConfigLoaded(true);
      });
  }, []);

  useEffect(() => {
    if (!token) {
      return undefined;
    }

    const expiresAt = parseTokenExpiration(token);
    if (!expiresAt) {
      return undefined;
    }

    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) {
      setToken(null);
      setUser(null);
      setLoading(false);
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setToken(null);
      setUser(null);
      setLoading(false);
    }, remainingMs);

    return () => window.clearTimeout(timeoutId);
  }, [token]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setToken(null);
      setUser(null);
      setLoading(false);
      setSsoError("");
    });

    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    const ssoToken = readSsoTokenFromHash();
    if (!ssoToken) {
      return undefined;
    }

    let active = true;
    setToken(null);
    setUser(null);
    setLoading(true);
    setSsoError("");
    apiJson("/auth/sso/exchange", {
      method: "POST",
      data: { token: ssoToken }
    })
      .then((payload) => {
        if (!active) return;
        setToken(payload.token);
        setUser(payload.user);
      })
      .catch((error) => {
        if (!active) return;
        setSsoError(error.message || "Falha ao validar login vindo do Ecossistema.");
      })
      .finally(() => {
        clearSsoHash();
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const pendingSsoToken = readSsoTokenFromHash();
    if (!token) {
      if (!pendingSsoToken) {
        setLoading(false);
      }
      return undefined;
    }

    let active = true;
    setLoading(true);
    apiJson("/auth/me", { token })
      .then((payload) => {
        if (active) {
          setUser(payload.user);
        }
      })
      .catch(() => {
        if (active) {
          setToken(null);
          setUser(null);
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [token]);

  const value = useMemo(
    () => ({
      token,
      user,
      loading,
      ssoError,
      appConfig,
      configLoaded,
      isAuthenticated: Boolean(token && user),
      async login(username, password) {
        setSsoError("");
        const payload = await apiJson("/auth/login", {
          method: "POST",
          data: { username, password }
        });
        setToken(payload.token);
        setUser(payload.user);
        return payload;
      },
      updateSession(nextToken, nextUser) {
        setToken(nextToken);
        setUser(nextUser);
      },
      logout() {
        setToken(null);
        setUser(null);
        setSsoError("");
      }
    }),
    [token, user, loading, ssoError, appConfig, configLoaded]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth deve ser usado dentro de AuthProvider.");
  }
  return context;
}
