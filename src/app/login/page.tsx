"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
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
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-gradient-to-b from-zinc-50 via-zinc-50 to-zinc-100 font-sans text-zinc-950 dark:from-black dark:via-black dark:to-zinc-950 dark:text-zinc-50">
      <div className="flex h-full w-full items-center justify-center p-4 lg:p-8">
        <main className="w-full max-w-md overflow-hidden rounded-3xl border border-zinc-200 bg-white/80 shadow-sm backdrop-blur dark:border-white/10 dark:bg-zinc-950/70">
          <div className="p-6 sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-white/10 dark:bg-white">
                  <Image
                    src="/images/image.png"
                    alt="ARES 118"
                    width={40}
                    height={40}
                    className="h-10 w-10 object-contain"
                    priority
                  />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-base font-semibold tracking-tight">Radio Ares</div>
                  <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                    Accesso operativo
                  </div>
                </div>
              </div>

              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
                  router.refresh();
                }}
              >
                <button
                  type="submit"
                  className="h-9 rounded-2xl border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-white/10 dark:bg-black/30 dark:text-zinc-200 dark:hover:bg-white/10"
                >
                  Reset session
                </button>
              </form>
            </div>

            <form onSubmit={onSubmit} className="mt-8 space-y-4">
              <div>
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  Username
                </label>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="mt-2 h-11 w-full rounded-2xl border border-zinc-200 bg-white px-3 text-sm outline-none focus:border-zinc-400 dark:border-white/10 dark:bg-black/40 dark:focus:border-white/30"
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
                  className="mt-2 h-11 w-full rounded-2xl border border-zinc-200 bg-white px-3 text-sm outline-none focus:border-zinc-400 dark:border-white/10 dark:bg-black/40 dark:focus:border-white/30"
                  type="password"
                  autoComplete="current-password"
                />
              </div>

              {error ? (
                <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                  {error}
                </div>
              ) : null}

              <button
                className="flex h-11 w-full items-center justify-center rounded-2xl bg-zinc-950 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-60 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
                disabled={loading}
                type="submit"
              >
                {loading ? "Accesso…" : "Entra"}
              </button>
            </form>
          </div>

          <div className="border-t border-zinc-200/70 px-6 py-4 text-[11px] text-zinc-500 dark:border-white/10 dark:text-zinc-400 sm:px-8">
            Usa le credenziali del portale ARES 118.
          </div>
        </main>
      </div>
    </div>
  );
}
