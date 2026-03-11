"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function SetupPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [hasUsers, setHasUsers] = useState(false);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/setup/status", { cache: "no-store" });
        const json = await res.json();
        if (!res.ok || !json?.ready) throw new Error(json?.error ?? "SETUP_ERROR");
        if (cancelled) return;
        setHasUsers(Boolean(json.hasUsers));
        setLoading(false);
        if (json.hasUsers) router.replace("/login");
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "ERROR");
          setLoading(false);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/setup/owner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      setError(json?.error ?? "ERROR");
      return;
    }
    router.replace("/radio");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-6 font-sans text-zinc-950 dark:bg-black dark:text-zinc-50">
      <main className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-white/10 dark:bg-zinc-950">
        <h1 className="text-xl font-semibold tracking-tight">Setup</h1>
        <div className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Crea il primo utente owner.
        </div>

        {loading ? (
          <div className="mt-6 text-sm text-zinc-600 dark:text-zinc-400">Caricamento…</div>
        ) : hasUsers ? (
          <div className="mt-6 text-sm text-zinc-600 dark:text-zinc-400">
            Setup già fatto. Reindirizzo al login…
          </div>
        ) : (
          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <div>
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Username
              </label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="mt-2 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none ring-0 focus:border-zinc-400 dark:border-white/10 dark:bg-black dark:focus:border-white/30"
                autoComplete="username"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Password
              </label>
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-2 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none ring-0 focus:border-zinc-400 dark:border-white/10 dark:bg-black dark:focus:border-white/30"
                type="password"
                autoComplete="new-password"
              />
              <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
                Minimo 8 caratteri.
              </div>
            </div>

            {error ? (
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                {error}
              </div>
            ) : null}

            <button
              className="flex h-11 w-full items-center justify-center rounded-xl bg-zinc-950 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
              type="submit"
            >
              Crea owner
            </button>
          </form>
        )}

        {error && !loading ? (
          <div className="mt-4 text-xs text-zinc-500 dark:text-zinc-500">
            Se sei su Vercel, imposta DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME.
          </div>
        ) : null}
      </main>
    </div>
  );
}

