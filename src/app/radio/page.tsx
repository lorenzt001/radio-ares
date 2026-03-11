"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type UserRole = "owner" | "moderator" | "user";

type Me = {
  id: number;
  username: string;
  role: UserRole;
  currentChannelId: number | null;
};

type Channel = {
  id: number;
  name: string;
};

type PresenceUser = {
  id: number;
  username: string;
  role: UserRole;
  currentChannelId: number | null;
};

type Signal = {
  id: number;
  fromUserId: number;
  toUserId: number | null;
  kind: string;
  payload: unknown;
};

const PTT_OPTIONS = [
  { label: "Spazio", code: "Space" },
  { label: "V", code: "KeyV" },
  { label: "B", code: "KeyB" },
  { label: "Ctrl", code: "ControlLeft" },
] as const;

type PttCode = (typeof PTT_OPTIONS)[number]["code"];

type SinkIdCapableAudio = HTMLAudioElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

function canManageUsers(role: UserRole): boolean {
  return role === "owner" || role === "moderator";
}

function canCreatePrivilegedUsers(role: UserRole): boolean {
  return role === "owner";
}

export default function RadioPage() {
  const router = useRouter();

  const [me, setMe] = useState<Me | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [users, setUsers] = useState<PresenceUser[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [pttKey, setPttKey] = useState<PttCode>("Space");
  const [isTalking, setIsTalking] = useState(false);

  const [outputVolume, setOutputVolume] = useState(0.9);
  const [inputGain, setInputGain] = useState(1.0);

  const [micDeviceId, setMicDeviceId] = useState<string | null>(null);
  const [outDeviceId, setOutDeviceId] = useState<string | null>(null);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);

  const [newChannelName, setNewChannelName] = useState("");
  const [newUserName, setNewUserName] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserRole, setNewUserRole] = useState<"user" | "moderator">("moderator");

  const heartbeatTimer = useRef<number | null>(null);
  const stateTimer = useRef<number | null>(null);
  const pollTimer = useRef<number | null>(null);
  const lastSignalId = useRef(0);

  const rawMicStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const inputGainNodeRef = useRef<GainNode | null>(null);
  const processedTrackRef = useRef<MediaStreamTrack | null>(null);
  const processedStreamRef = useRef<MediaStream | null>(null);

  const peersRef = useRef(new Map<number, RTCPeerConnection>());
  const audioElsRef = useRef(new Map<number, HTMLAudioElement>());

  const usersByChannel = useMemo(() => {
    const map = new Map<number, PresenceUser[]>();
    for (const u of users) {
      if (u.currentChannelId == null) continue;
      const list = map.get(u.currentChannelId) ?? [];
      list.push(u);
      map.set(u.currentChannelId, list);
    }
    return map;
  }, [users]);

  async function refreshDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    setAudioInputs(devices.filter((d) => d.kind === "audioinput"));
    setAudioOutputs(devices.filter((d) => d.kind === "audiooutput"));
  }

  async function ensureMic(nextDeviceId: string | null) {
    const constraints: MediaStreamConstraints = {
      audio:
        nextDeviceId && nextDeviceId !== "default"
          ? { deviceId: { exact: nextDeviceId } }
          : true,
      video: false,
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    rawMicStreamRef.current?.getTracks().forEach((t) => t.stop());
    rawMicStreamRef.current = stream;

    try {
      await audioContextRef.current?.close();
    } catch {}

    const ctx = new AudioContext();
    audioContextRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const gainNode = ctx.createGain();
    gainNode.gain.value = inputGain;
    inputGainNodeRef.current = gainNode;
    const dest = ctx.createMediaStreamDestination();
    source.connect(gainNode).connect(dest);

    processedStreamRef.current = dest.stream;
    const track = dest.stream.getAudioTracks()[0];
    processedTrackRef.current = track;
    track.enabled = false;

    for (const pc of peersRef.current.values()) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind === "audio") {
          await sender.replaceTrack(track);
        }
      }
    }

    await refreshDevices();
  }

  async function activateAudio() {
    if (!processedTrackRef.current) {
      await ensureMic(micDeviceId);
    }
    const ctx = audioContextRef.current;
    if (ctx && ctx.state !== "running") {
      await ctx.resume().catch(() => null);
    }
  }

  function closeAllPeers() {
    for (const [uid, pc] of peersRef.current) {
      try {
        pc.ontrack = null;
        pc.onicecandidate = null;
        pc.onconnectionstatechange = null;
        pc.close();
      } catch {}
      peersRef.current.delete(uid);
    }
    for (const [uid, el] of audioElsRef.current) {
      try {
        el.srcObject = null;
      } catch {}
      audioElsRef.current.delete(uid);
    }
  }

  async function sendSignal(
    channelId: number,
    toUserId: number | null,
    kind: string,
    payload: unknown,
  ) {
    await fetch("/api/signaling/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId, toUserId, kind, payload }),
    });
  }

  async function createPeer(channelId: number, otherUserId: number) {
    const existing = peersRef.current.get(otherUserId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    peersRef.current.set(otherUserId, pc);

    const track = processedTrackRef.current;
    const stream = processedStreamRef.current;
    if (track) {
      pc.addTrack(track, stream ?? new MediaStream([track]));
    }

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      void sendSignal(channelId, otherUserId, "ice", ev.candidate);
    };

    pc.ontrack = async (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      let el = audioElsRef.current.get(otherUserId);
      if (!el) {
        el = new Audio();
        el.autoplay = true;
        audioElsRef.current.set(otherUserId, el);
      }
      el.srcObject = stream;
      el.volume = outputVolume;
      if (outDeviceId && "setSinkId" in el) {
        const sinkable = el as SinkIdCapableAudio;
        await sinkable.setSinkId?.(outDeviceId).catch(() => null);
      }
      await el.play().catch(() => null);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        peersRef.current.delete(otherUserId);
      }
    };

    return pc;
  }

  async function handleSignal(channelId: number, s: Signal) {
    if (!me) return;
    if (s.fromUserId === me.id) return;

    if (s.kind === "offer") {
      const pc = await createPeer(channelId, s.fromUserId);
      await pc.setRemoteDescription(new RTCSessionDescription(s.payload as RTCSessionDescriptionInit));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendSignal(channelId, s.fromUserId, "answer", answer);
      return;
    }

    if (s.kind === "answer") {
      const pc = peersRef.current.get(s.fromUserId);
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(s.payload as RTCSessionDescriptionInit));
      return;
    }

    if (s.kind === "ice") {
      const pc = peersRef.current.get(s.fromUserId);
      if (!pc) return;
      await pc
        .addIceCandidate(new RTCIceCandidate(s.payload as RTCIceCandidateInit))
        .catch(() => null);
    }
  }

  async function pollSignals(channelId: number) {
    const afterId = lastSignalId.current;
    const res = await fetch(`/api/signaling/poll?channelId=${channelId}&afterId=${afterId}`, {
      cache: "no-store",
    });
    if (!res.ok) return;
    const json = await res.json().catch(() => null);
    const signals = (json?.signals ?? []) as Signal[];
    for (const s of signals) {
      lastSignalId.current = Math.max(lastSignalId.current, Number(s.id));
      await handleSignal(channelId, s);
    }
  }

  async function connectToChannelPeers(channelId: number, members: PresenceUser[]) {
    if (!me) return;
    for (const other of members) {
      if (other.id === me.id) continue;
      if (peersRef.current.has(other.id)) continue;
      if (me.id < other.id) {
        const pc = await createPeer(channelId, other.id);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await sendSignal(channelId, other.id, "offer", offer);
      }
    }
  }

  async function heartbeat(channelId: number | null) {
    const res = await fetch("/api/presence/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId }),
    });
    const json = await res.json().catch(() => null);
    if (res.status === 401) {
      router.replace("/login");
      return;
    }
    if (res.ok && json?.currentChannelId !== undefined && json.currentChannelId !== channelId) {
      setSelectedChannelId(json.currentChannelId === null ? null : Number(json.currentChannelId));
    }
  }

  async function loadState() {
    const res = await fetch("/api/presence/state", { cache: "no-store" });
    if (res.status === 401) {
      router.replace("/login");
      return;
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      setError(json?.error ?? "ERROR");
      return;
    }

    setMe(json.me);
    setChannels(json.channels ?? []);
    setUsers(json.users ?? []);
    setLoading(false);

    const forcedChannelId =
      json.me?.currentChannelId === null || json.me?.currentChannelId === undefined
        ? null
        : Number(json.me.currentChannelId);

    setSelectedChannelId((prev) => {
      if (prev === null && forcedChannelId !== null) return forcedChannelId;
      if (prev !== null && forcedChannelId !== null && prev !== forcedChannelId) return forcedChannelId;
      if (prev === null && forcedChannelId === null) return prev;
      return prev;
    });
  }

  useEffect(() => {
    let cancelled = false;
    async function init() {
      setLoading(true);
      setError(null);
      try {
        await loadState();
        if (cancelled) return;
        await ensureMic(micDeviceId);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "ERROR");
          setLoading(false);
        }
      }
    }
    init();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!processedTrackRef.current) return;
    processedTrackRef.current.enabled = isTalking;
  }, [isTalking]);

  useEffect(() => {
    if (!inputGainNodeRef.current) return;
    inputGainNodeRef.current.gain.value = inputGain;
  }, [inputGain]);

  useEffect(() => {
    for (const el of audioElsRef.current.values()) {
      el.volume = outputVolume;
    }
  }, [outputVolume]);

  useEffect(() => {
    if (!outDeviceId) return;
    for (const el of audioElsRef.current.values()) {
      if ("setSinkId" in el) {
        const sinkable = el as SinkIdCapableAudio;
        void sinkable.setSinkId?.(outDeviceId).catch(() => null);
      }
    }
  }, [outDeviceId]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code !== pttKey) return;
      if (e.repeat) return;
      void activateAudio();
      setIsTalking(true);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code !== pttKey) return;
      setIsTalking(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [pttKey]);

  useEffect(() => {
    if (!me) return;

    if (stateTimer.current) window.clearInterval(stateTimer.current);
    stateTimer.current = window.setInterval(() => {
      void loadState();
    }, 1000);

    return () => {
      if (stateTimer.current) window.clearInterval(stateTimer.current);
    };
  }, [me?.id]);

  useEffect(() => {
    if (!me) return;

    if (heartbeatTimer.current) window.clearInterval(heartbeatTimer.current);
    heartbeatTimer.current = window.setInterval(() => {
      void heartbeat(selectedChannelId);
    }, 4000);

    return () => {
      if (heartbeatTimer.current) window.clearInterval(heartbeatTimer.current);
    };
  }, [me?.id, selectedChannelId]);

  useEffect(() => {
    if (!me || !selectedChannelId) return;

    closeAllPeers();
    lastSignalId.current = 0;

    if (pollTimer.current) window.clearInterval(pollTimer.current);
    pollTimer.current = window.setInterval(() => {
      void pollSignals(selectedChannelId);
    }, 700);

    const members = (usersByChannel.get(selectedChannelId) ?? []).filter((u) => u.id !== me.id);
    void connectToChannelPeers(selectedChannelId, members);

    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current);
    };
  }, [me?.id, selectedChannelId]);

  useEffect(() => {
    if (!me || !selectedChannelId) return;
    const members = usersByChannel.get(selectedChannelId) ?? [];
    void connectToChannelPeers(selectedChannelId, members);
  }, [usersByChannel, me?.id, selectedChannelId]);

  useEffect(() => {
    return () => {
      closeAllPeers();
      rawMicStreamRef.current?.getTracks().forEach((t) => t.stop());
      void audioContextRef.current?.close().catch(() => null);
    };
  }, []);

  async function onJoin(channelId: number) {
    setSelectedChannelId(channelId);
    await heartbeat(channelId);
  }

  async function onLogout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    router.replace("/login");
  }

  async function onCreateChannel() {
    if (!newChannelName.trim()) return;
    const res = await fetch("/api/channels/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: newChannelName.trim() }),
    });
    if (res.ok) setNewChannelName("");
    await loadState();
  }

  async function onMoveUser(userId: number, channelId: number | null) {
    await fetch("/api/admin/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, channelId }),
    }).catch(() => null);
    await loadState();
  }

  async function onCreateUser() {
    if (!newUserName.trim() || newUserPassword.length < 8) return;
    const res = await fetch("/api/admin/users/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: newUserName.trim(),
        password: newUserPassword,
        role: newUserRole,
      }),
    });
    if (res.ok) {
      setNewUserName("");
      setNewUserPassword("");
    }
    await loadState();
  }

  const selectedChannel = channels.find((c) => c.id === selectedChannelId) ?? null;

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-6 font-sans text-zinc-950 dark:bg-black dark:text-zinc-50">
        <div className="text-sm text-zinc-600 dark:text-zinc-400">Caricamento…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 font-sans text-zinc-950 dark:bg-black dark:text-zinc-50">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-zinc-950 text-white dark:bg-white dark:text-black flex items-center justify-center text-sm font-semibold">
              RA
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight">Radio Ares</div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                {me ? `${me.username} · ${me.role}` : "Offline"}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => router.refresh()}
              className="h-9 rounded-xl border border-zinc-200 px-3 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-white/10 dark:text-zinc-200 dark:hover:bg-white/10"
            >
              Refresh
            </button>
            <button
              onClick={onLogout}
              className="h-9 rounded-xl bg-zinc-950 px-3 text-xs font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
            >
              Esci
            </button>
          </div>
        </header>

        {error ? (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <section className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-zinc-950">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Radio</h2>
              {me && canManageUsers(me.role) ? (
                <div className="flex items-center gap-2">
                  <input
                    value={newChannelName}
                    onChange={(e) => setNewChannelName(e.target.value)}
                    placeholder="Nuovo canale"
                    className="h-9 w-40 rounded-xl border border-zinc-200 bg-white px-3 text-xs outline-none focus:border-zinc-400 dark:border-white/10 dark:bg-black dark:focus:border-white/30"
                  />
                  <button
                    onClick={onCreateChannel}
                    className="h-9 rounded-xl bg-zinc-950 px-3 text-xs font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
                  >
                    Crea
                  </button>
                </div>
              ) : null}
            </div>

            <div className="mt-4 space-y-3">
              {channels.map((c) => {
                const members = usersByChannel.get(c.id) ?? [];
                const isSelected = c.id === selectedChannelId;
                return (
                  <div
                    key={c.id}
                    className={`rounded-2xl border p-3 ${
                      isSelected
                        ? "border-zinc-950 bg-zinc-50 dark:border-white/30 dark:bg-white/5"
                        : "border-zinc-200 bg-white dark:border-white/10 dark:bg-zinc-950"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-medium">{c.name}</div>
                        <div className="text-xs text-zinc-500 dark:text-zinc-400">
                          {members.length} online
                        </div>
                      </div>
                      <button
                        onClick={() => onJoin(c.id)}
                        className={`h-9 rounded-xl px-3 text-xs font-medium ${
                          isSelected
                            ? "bg-zinc-950 text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
                            : "border border-zinc-200 text-zinc-700 hover:bg-zinc-100 dark:border-white/10 dark:text-zinc-200 dark:hover:bg-white/10"
                        }`}
                      >
                        {isSelected ? "Dentro" : "Entra"}
                      </button>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {members.length ? (
                        members.map((u) => (
                          <div
                            key={u.id}
                            className="rounded-full border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 dark:border-white/10 dark:bg-black dark:text-zinc-200"
                          >
                            {u.username}
                          </div>
                        ))
                      ) : (
                        <div className="text-xs text-zinc-500 dark:text-zinc-400">
                          Nessuno collegato
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-zinc-950">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">
                {selectedChannel ? selectedChannel.name : "Nessuna radio"}
              </h2>
              <div
                className={`text-xs ${
                  isTalking ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-500 dark:text-zinc-400"
                }`}
              >
                {isTalking ? "Parlando" : "In ascolto"}
              </div>
            </div>

            <div className="mt-6 flex items-center justify-center">
              <button
                onMouseDown={() => {
                  void activateAudio();
                  setIsTalking(true);
                }}
                onMouseUp={() => setIsTalking(false)}
                onMouseLeave={() => setIsTalking(false)}
                onTouchStart={() => {
                  void activateAudio();
                  setIsTalking(true);
                }}
                onTouchEnd={() => setIsTalking(false)}
                className={`h-44 w-44 rounded-full border text-sm font-semibold transition ${
                  isTalking
                    ? "border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-zinc-200 bg-white text-zinc-950 hover:bg-zinc-100 dark:border-white/10 dark:bg-black dark:text-zinc-50 dark:hover:bg-white/10"
                }`}
              >
                Tieni premuto
              </button>
            </div>

            <div className="mt-6 rounded-2xl border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600 dark:border-white/10 dark:bg-black dark:text-zinc-400">
              PTT: {PTT_OPTIONS.find((o) => o.code === pttKey)?.label}
            </div>
          </section>

          <section className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-zinc-950">
            <h2 className="text-sm font-semibold">Impostazioni</h2>

            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                    Volume uscita
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={outputVolume}
                    onChange={(e) => setOutputVolume(Number(e.target.value))}
                    className="mt-2 w-full"
                  />
                </div>
                <div>
                  <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                    Volume entrata
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.01}
                    value={inputGain}
                    onChange={(e) => setInputGain(Number(e.target.value))}
                    className="mt-2 w-full"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                    Microfono
                  </div>
                  <select
                    value={micDeviceId ?? "default"}
                    onChange={async (e) => {
                      const id = e.target.value;
                      setMicDeviceId(id);
                      await ensureMic(id);
                    }}
                    className="mt-2 h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-xs outline-none focus:border-zinc-400 dark:border-white/10 dark:bg-black dark:focus:border-white/30"
                  >
                    <option value="default">Default</option>
                    {audioInputs.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Mic ${d.deviceId.slice(0, 6)}`}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                    Uscita audio
                  </div>
                  <select
                    value={outDeviceId ?? "default"}
                    onChange={(e) => setOutDeviceId(e.target.value)}
                    className="mt-2 h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-xs outline-none focus:border-zinc-400 disabled:opacity-50 dark:border-white/10 dark:bg-black dark:focus:border-white/30"
                    disabled={audioOutputs.length === 0}
                  >
                    <option value="default">Default</option>
                    {audioOutputs.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Out ${d.deviceId.slice(0, 6)}`}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  Tasto PTT
                </div>
                <select
                  value={pttKey}
                  onChange={(e) => setPttKey(e.target.value as PttCode)}
                  className="mt-2 h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-xs outline-none focus:border-zinc-400 dark:border-white/10 dark:bg-black dark:focus:border-white/30"
                >
                  {PTT_OPTIONS.map((o) => (
                    <option key={o.code} value={o.code}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              {me && canManageUsers(me.role) ? (
                <div className="rounded-2xl border border-zinc-200 p-3 dark:border-white/10">
                  <div className="text-xs font-semibold">Gestione utenti</div>
                  <div className="mt-3 space-y-2">
                    {users.map((u) => (
                      <div key={u.id} className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium">{u.username}</div>
                          <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                            {u.role}
                          </div>
                        </div>
                        <select
                          value={u.currentChannelId ?? ""}
                          onChange={(e) => {
                            const v = e.target.value;
                            void onMoveUser(u.id, v ? Number(v) : null);
                          }}
                          className="h-9 w-40 rounded-xl border border-zinc-200 bg-white px-2 text-xs outline-none focus:border-zinc-400 dark:border-white/10 dark:bg-black dark:focus:border-white/30"
                        >
                          <option value="">Fuori</option>
                          {channels.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>

                  {me && canCreatePrivilegedUsers(me.role) ? (
                    <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-white/10">
                      <div className="text-xs font-semibold">Crea utente</div>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <input
                          value={newUserName}
                          onChange={(e) => setNewUserName(e.target.value)}
                          placeholder="Username"
                          className="h-10 rounded-xl border border-zinc-200 bg-white px-3 text-xs outline-none focus:border-zinc-400 dark:border-white/10 dark:bg-black dark:focus:border-white/30"
                        />
                        <select
                          value={newUserRole}
                          onChange={(e) =>
                            setNewUserRole(e.target.value === "user" ? "user" : "moderator")
                          }
                          className="h-10 rounded-xl border border-zinc-200 bg-white px-3 text-xs outline-none focus:border-zinc-400 dark:border-white/10 dark:bg-black dark:focus:border-white/30"
                        >
                          <option value="moderator">moderator</option>
                          <option value="user">user</option>
                        </select>
                        <input
                          value={newUserPassword}
                          onChange={(e) => setNewUserPassword(e.target.value)}
                          placeholder="Password"
                          type="password"
                          className="h-10 rounded-xl border border-zinc-200 bg-white px-3 text-xs outline-none focus:border-zinc-400 dark:border-white/10 dark:bg-black dark:focus:border-white/30"
                        />
                        <button
                          onClick={onCreateUser}
                          className="h-10 rounded-xl bg-zinc-950 px-3 text-xs font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
                        >
                          Crea
                        </button>
                      </div>
                      <div className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-500">
                        L’utente moderator può spostare persone tra radio.
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <button
                onClick={async () => {
                  setIsTalking(false);
                  await ensureMic(micDeviceId);
                }}
                className="h-10 w-full rounded-xl border border-zinc-200 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-white/10 dark:text-zinc-200 dark:hover:bg-white/10"
              >
                Reinizializza audio
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

