"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      try {
        const setupRes = await fetch("/api/setup/status", { cache: "no-store" });
        const setup = await setupRes.json();
        if (!setupRes.ok || !setup?.ready) throw new Error(setup?.error ?? "SETUP_ERROR");
        if (cancelled) return;

        if (!setup.hasUsers) {
          router.replace("/setup");
          return;
        }

        const meRes = await fetch("/api/auth/me", { cache: "no-store" });
        if (cancelled) return;
        if (meRes.ok) {
          router.replace("/radio");
          return;
        }
        router.replace("/login");
      } catch {
        if (!cancelled) setStatus("error");
      }
    }
    boot();
    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (status === "loading") return;
  }, [status]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-6 font-sans text-zinc-950 dark:bg-black dark:text-zinc-50">
      <main className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-white/10 dark:bg-zinc-950">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold tracking-tight">Radio Ares</h1>
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            {status === "error" ? "DB non pronta" : "Caricamento"}
          </div>
        </div>
        <div className="mt-6 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          {status === "error"
            ? "Controlla le variabili DB* e riprova."
            : "Ti sto portando nella schermata giusta."}
        </div>
      </main>
    </div>
  );
}
