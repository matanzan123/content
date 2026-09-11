"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut as fbSignOut,
  type User,
} from "firebase/auth";
import { getFirebaseAuth, isFirebaseConfigured } from "@/lib/firebase";

/* --------------------------------------------------------------------------
   SERVER SESSION SYNC.

   Signing in with Firebase only establishes an identity IN THE BROWSER. Every
   server guard (`getAccessContext`, `requireStage`) reads the httpOnly cookie
   minted by `/api/auth/session`, so without this exchange the server keeps
   treating a signed-in person as a visitor — which is why a finished applicant
   was never routed on to interview booking.

   The ID token is passed to our own endpoint and nowhere else. It is never
   logged, never stored, and never put in a URL.
   -------------------------------------------------------------------------- */

/** Exchanges an ID token for the server session cookie. Never throws. */
async function openServerSession(idToken: string): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    return response.ok;
  } catch {
    // Offline or blocked. The caller retries on the next auth state change.
    return false;
  }
}

/** Clears the server session. The route also revokes the refresh tokens. */
async function closeServerSession(): Promise<void> {
  try {
    await fetch("/api/auth/session", { method: "DELETE" });
  } catch {
    // Best effort: the browser has already dropped the Firebase user.
  }
}

/** Keys into `onboarding` in the dictionaries. */
export type AuthErrorKey = "signInNotConfigured" | "unauthorizedDomain" | "signInFailed";

type AuthValue = {
  user: User | null;
  /** True until the first onAuthStateChanged callback settles. */
  loading: boolean;
  configured: boolean;
  /** Stable key, not a sentence: AuthGate translates it at render time so the
   *  message follows a language switch and the provider stays locale-neutral. */
  error: AuthErrorKey | null;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(isFirebaseConfigured);
  const [error, setError] = useState<AuthErrorKey | null>(null);
  const router = useRouter();
  /**
   * The uid whose server session this page load has already opened. It keeps
   * one sign-in to one exchange: `onAuthStateChanged` also fires on an
   * ordinary token refresh, and re-minting a cookie on every one of those
   * would be pointless traffic. It is cleared on failure so the next auth
   * state change retries, and on sign-out so the next sign-in exchanges again.
   */
  const syncedUid = useRef<string | null>(null);

  useEffect(() => {
    // When Firebase isn't configured `loading` already starts false, so there
    // is nothing to settle — just skip the subscription.
    const auth = getFirebaseAuth();
    if (!auth) return;

    let cancelled = false;

    const unsubscribe = onAuthStateChanged(auth, (next) => {
      setUser(next);

      if (!next) {
        // Only tear down a session this page load actually opened; an ordinary
        // visitor who was never signed in has nothing to clear.
        const hadSession = syncedUid.current !== null;
        syncedUid.current = null;
        setLoading(false);
        if (hadSession) void closeServerSession();
        return;
      }

      if (syncedUid.current === next.uid) {
        setLoading(false);
        return;
      }
      syncedUid.current = next.uid;

      void (async () => {
        let opened = false;
        try {
          opened = await openServerSession(await next.getIdToken());
        } catch {
          // Token could not be minted — treated exactly like a failed exchange.
        }
        if (cancelled) return;
        if (!opened) syncedUid.current = null;
        setLoading(false);
        // This page was rendered by the server BEFORE the cookie existed, so
        // its guards ran as "unauthenticated". Re-running them now is what
        // sends an applicant on to the stage they actually belong in. Guarded
        // by `syncedUid`, so it happens once per sign-in, never in a loop.
        if (opened) router.refresh();
      })();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [router]);

  const signInWithGoogle = useCallback(async () => {
    setError(null);
    const auth = getFirebaseAuth();
    if (!auth) {
      setError("signInNotConfigured");
      return;
    }
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return;
      setError(
        code === "auth/unauthorized-domain"
          ? "unauthorizedDomain"
          : "signInFailed"
      );
    }
  }, []);

  const signOut = useCallback(async () => {
    // The server session is cleared by the `onAuthStateChanged` handler above,
    // so EVERY way of losing the Firebase user — this button, another tab, a
    // revoked account — ends the server session too, not just this one path.
    const auth = getFirebaseAuth();
    if (auth) await fbSignOut(auth);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      loading,
      configured: isFirebaseConfigured,
      error,
      signInWithGoogle,
      signOut,
    }),
    [user, loading, error, signInWithGoogle, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
