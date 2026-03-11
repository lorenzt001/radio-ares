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

type PeerStatus = {
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
};

type RightPanelTab = "audio" | "utenti" | "diagnostica";

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
  const [peerStatus, setPeerStatus] = useState<Record<string, PeerStatus>>({});
  const [rightTab, setRightTab] = useState<RightPanelTab>("audio");
  const [inputLevel, setInputLevel] = useState(0);
  const [engineStatus, setEngineStatus] = useState<{
    audioContext: string;
    beep: string;
    micTrack: string;
  }>({ audioContext: "n/a", beep: "n/a", micTrack: "n/a" });

  const [pttKey, setPttKey] = useState<PttCode>("Space");
  const [isTalking, setIsTalking] = useState(false);

  const [outputVolume, setOutputVolume] = useState(0.9);
  const [inputGain, setInputGain] = useState(1.0);

  const [micDeviceId, setMicDeviceId] = useState<string | null>(null);
  const [outDeviceId, setOutDeviceId] = useState<string | null>(null);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);

  const [channelQuery, setChannelQuery] = useState("");
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
  const inputAnalyserRef = useRef<AnalyserNode | null>(null);
  const processedTrackRef = useRef<MediaStreamTrack | null>(null);
  const processedStreamRef = useRef<MediaStream | null>(null);

  const peersRef = useRef(new Map<number, RTCPeerConnection>());
  const audioElsRef = useRef(new Map<number, HTMLAudioElement>());

  const meIdRef = useRef<number | null>(null);
  const selectedChannelIdRef = useRef<number | null>(null);

  const beepContextRef = useRef<AudioContext | null>(null);
  const beepOpenBufferRef = useRef<AudioBuffer | null>(null);
  const beepCloseBufferRef = useRef<AudioBuffer | null>(null);
  const beepGainRef = useRef<GainNode | null>(null);
  const talkSeqRef = useRef(0);
  const pendingIceRef = useRef(new Map<number, RTCIceCandidateInit[]>());
  const reconnectAttemptsRef = useRef(new Map<number, { count: number; lastAt: number }>());

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

  useEffect(() => {
    meIdRef.current = me?.id ?? null;
  }, [me?.id]);

  useEffect(() => {
    selectedChannelIdRef.current = selectedChannelId;
  }, [selectedChannelId]);

  useEffect(() => {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.gain.value = 0.5;
    gain.connect(ctx.destination);
    beepContextRef.current = ctx;
    beepGainRef.current = gain;

    async function load(url: string) {
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      return await ctx.decodeAudioData(buf);
    }

    void load("/suoni/apertura.mp3")
      .then((b) => {
        beepOpenBufferRef.current = b;
      })
      .catch(() => null);

    void load("/suoni/chiusura.mp3")
      .then((b) => {
        beepCloseBufferRef.current = b;
      })
      .catch(() => null);

    return () => {
      void ctx.close().catch(() => null);
    };
  }, []);

  async function refreshDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    setAudioInputs(devices.filter((d) => d.kind === "audioinput"));
    setAudioOutputs(devices.filter((d) => d.kind === "audiooutput"));
  }

  async function ensureMic(nextDeviceId: string | null) {
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (nextDeviceId && nextDeviceId !== "default") {
      audioConstraints.deviceId = { exact: nextDeviceId };
    }
    const constraints: MediaStreamConstraints = {
      audio: audioConstraints,
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
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.8;
    inputAnalyserRef.current = analyser;
    const dest = ctx.createMediaStreamDestination();
    source.connect(gainNode);
    gainNode.connect(analyser);
    analyser.connect(dest);

    processedStreamRef.current = dest.stream;
    const track = dest.stream.getAudioTracks()[0];
    processedTrackRef.current = track;
    track.enabled = false;

    for (const [otherUserId, pc] of peersRef.current) {
      const audioSender = pc.getSenders().find((s) => s.track?.kind === "audio") ?? null;
      if (audioSender) {
        await audioSender.replaceTrack(track).catch(() => null);
        continue;
      }

      pc.addTrack(track, dest.stream);

      const meId = meIdRef.current;
      const channelId = selectedChannelIdRef.current;
      if (meId && channelId && meId < otherUserId) {
        const offer = await pc.createOffer().catch(() => null);
        if (!offer) continue;
        await pc.setLocalDescription(offer).catch(() => null);
        if (pc.localDescription) {
          await sendSignal(channelId, otherUserId, "offer", pc.localDescription).catch(() => null);
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
    const beepCtx = beepContextRef.current;
    if (beepCtx && beepCtx.state !== "running") {
      await beepCtx.resume().catch(() => null);
    }
  }

  function playBeep(kind: "open" | "close") {
    const ctx = beepContextRef.current;
    const gain = beepGainRef.current;
    if (!ctx || !gain) return;
    const buffer = kind === "open" ? beepOpenBufferRef.current : beepCloseBufferRef.current;
    if (!buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(gain);
    src.start(0);
  }

  async function startTalking() {
    const seq = ++talkSeqRef.current;
    await activateAudio();
    if (talkSeqRef.current !== seq) return;

    const buffer = beepOpenBufferRef.current;
    if (buffer) {
      playBeep("open");
      const delayMs = Math.min(500, Math.max(0, Math.round(buffer.duration * 1000)));
      window.setTimeout(() => {
        if (talkSeqRef.current !== seq) return;
        setIsTalking(true);
      }, delayMs);
      return;
    }

    setIsTalking(true);
  }

  function stopTalking() {
    ++talkSeqRef.current;
    setIsTalking(false);
    playBeep("close");
  }

  function closeAllPeers() {
    for (const [uid, pc] of peersRef.current) {
      try {
        pc.close();
      } catch {}
      peersRef.current.delete(uid);
    }
    pendingIceRef.current.clear();
    reconnectAttemptsRef.current.clear();
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
      iceServers: [
        {
          urls: [
            "stun:stun.l.google.com:19302",
            "stun:stun1.l.google.com:19302",
            "stun:stun2.l.google.com:19302",
            "stun:stun3.l.google.com:19302",
            "stun:stun4.l.google.com:19302",
            "stun:stun.cloudflare.com:3478",
          ],
        },
      ],
      iceCandidatePoolSize: 10,
    });
    peersRef.current.set(otherUserId, pc);
    setPeerStatus((prev) => ({
      ...prev,
      [String(otherUserId)]: {
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
      },
    }));

    const track = processedTrackRef.current;
    const stream = processedStreamRef.current;
    if (track) {
      pc.addTrack(track, stream ?? new MediaStream([track]));
    }

    pc.addEventListener("icecandidate", (ev) => {
      const e = ev as RTCPeerConnectionIceEvent;
      if (!e.candidate) return;
      void sendSignal(channelId, otherUserId, "ice", e.candidate);
    });

    pc.addEventListener("track", (ev) => {
      const e = ev as RTCTrackEvent;
      const stream = e.streams[0] ?? new MediaStream([e.track]);
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
        void sinkable.setSinkId?.(outDeviceId).catch(() => null);
      }
      void el.play().catch(() => null);
    });

    pc.addEventListener("connectionstatechange", () => {
      setPeerStatus((prev) => ({
        ...prev,
        [String(otherUserId)]: {
          connectionState: pc.connectionState,
          iceConnectionState: pc.iceConnectionState,
        },
      }));
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        peersRef.current.delete(otherUserId);
        setPeerStatus((prev) => {
          const next = { ...prev };
          delete next[String(otherUserId)];
          return next;
        });
        if (pc.connectionState === "failed") {
          const now = Date.now();
          const prev = reconnectAttemptsRef.current.get(otherUserId) ?? { count: 0, lastAt: 0 };
          const recent = now - prev.lastAt < 15000;
          const next = { count: recent ? prev.count + 1 : 1, lastAt: now };
          reconnectAttemptsRef.current.set(otherUserId, next);
          if (next.count <= 3) {
            const meId = meIdRef.current;
            const activeChannelId = selectedChannelIdRef.current;
            if (meId && activeChannelId && meId < otherUserId) {
              void (async () => {
                try {
                  const pc2 = await createPeer(activeChannelId, otherUserId);
                  const offer = await pc2.createOffer().catch(() => null);
                  if (!offer) return;
                  await pc2.setLocalDescription(offer).catch(() => null);
                  if (pc2.localDescription) {
                    await sendSignal(activeChannelId, otherUserId, "offer", pc2.localDescription);
                  }
                } catch {}
              })();
            }
          }
        }
      }
    });

    pc.addEventListener("iceconnectionstatechange", () => {
      setPeerStatus((prev) => ({
        ...prev,
        [String(otherUserId)]: {
          connectionState: pc.connectionState,
          iceConnectionState: pc.iceConnectionState,
        },
      }));
    });

    return pc;
  }

  async function handleSignal(channelId: number, s: Signal) {
    if (!me) return;
    if (s.fromUserId === me.id) return;

    if (s.kind === "offer") {
      const pc = await createPeer(channelId, s.fromUserId);
      if (pc.signalingState !== "stable") {
        await pc.setLocalDescription({ type: "rollback" }).catch(() => null);
      }
      await pc.setRemoteDescription(
        new RTCSessionDescription(s.payload as RTCSessionDescriptionInit),
      );
      const pending = pendingIceRef.current.get(s.fromUserId) ?? [];
      pendingIceRef.current.delete(s.fromUserId);
      for (const c of pending) {
        await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => null);
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendSignal(channelId, s.fromUserId, "answer", pc.localDescription ?? answer);
      return;
    }

    if (s.kind === "answer") {
      const pc = peersRef.current.get(s.fromUserId);
      if (!pc) return;
      await pc.setRemoteDescription(
        new RTCSessionDescription(s.payload as RTCSessionDescriptionInit),
      );
      const pending = pendingIceRef.current.get(s.fromUserId) ?? [];
      pendingIceRef.current.delete(s.fromUserId);
      for (const c of pending) {
        await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => null);
      }
      return;
    }

    if (s.kind === "ice") {
      const pc = peersRef.current.get(s.fromUserId);
      if (!pc) return;
      const candidateInit = s.payload as RTCIceCandidateInit;
      if (!pc.remoteDescription) {
        const list = pendingIceRef.current.get(s.fromUserId) ?? [];
        list.push(candidateInit);
        pendingIceRef.current.set(s.fromUserId, list);
        return;
      }
      await pc.addIceCandidate(new RTCIceCandidate(candidateInit)).catch(() => null);
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
      try {
        await handleSignal(channelId, s);
      } catch {}
    }
  }

  async function connectToChannelPeers(channelId: number, members: PresenceUser[]) {
    if (!me) return;
    for (const other of members) {
      if (other.id === me.id) continue;
      if (peersRef.current.has(other.id)) continue;
      if (me.id < other.id) {
        const pc = await createPeer(channelId, other.id);
        const offer = await pc.createOffer().catch(() => null);
        if (!offer) continue;
        await pc.setLocalDescription(offer).catch(() => null);
        await sendSignal(channelId, other.id, "offer", pc.localDescription ?? offer).catch(
          () => null,
        );
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
    const t = window.setInterval(() => {
      const analyser = inputAnalyserRef.current;
      if (!analyser) {
        setInputLevel(0);
        return;
      }
      const data = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const x = (data[i] - 128) / 128;
        sum += x * x;
      }
      const rms = Math.sqrt(sum / data.length);
      setInputLevel(rms);
    }, 80);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => {
      setEngineStatus({
        audioContext: audioContextRef.current?.state ?? "n/a",
        beep: beepContextRef.current?.state ?? "n/a",
        micTrack: processedTrackRef.current?.readyState ?? "n/a",
      });
    }, 500);
    return () => window.clearInterval(t);
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
      void startTalking();
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code !== pttKey) return;
      stopTalking();
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
    const connectTimer = window.setTimeout(() => {
      void connectToChannelPeers(selectedChannelId, members);
    }, 0);

    return () => {
      window.clearTimeout(connectTimer);
      if (pollTimer.current) window.clearInterval(pollTimer.current);
    };
  }, [me?.id, selectedChannelId]);

  useEffect(() => {
    if (!me || !selectedChannelId) return;
    const members = usersByChannel.get(selectedChannelId) ?? [];
    const connectTimer = window.setTimeout(() => {
      void connectToChannelPeers(selectedChannelId, members);
    }, 0);
    return () => window.clearTimeout(connectTimer);
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
  const peerEntries = Object.entries(peerStatus);
  const connectedPeerCount = peerEntries.filter(
    ([, s]) => s.connectionState === "connected" || s.iceConnectionState === "connected",
  ).length;
  const inputLevelPct = Math.min(1, Math.max(0, inputLevel * 3));
  const filteredChannels =
    channelQuery.trim().length === 0
      ? channels
      : channels.filter((c) => c.name.toLowerCase().includes(channelQuery.trim().toLowerCase()));

  if (loading) {
    return (
      <div className="h-screen w-screen overflow-hidden bg-gradient-to-b from-zinc-50 via-zinc-50 to-zinc-100 font-sans text-zinc-950 dark:from-black dark:via-black dark:to-zinc-950 dark:text-zinc-50">
        <div className="flex h-full w-full items-center justify-center px-6">
          <div className="flex items-center gap-3 rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-700 shadow-sm dark:border-white/10 dark:bg-zinc-950 dark:text-zinc-200">
            <div className="h-2 w-2 rounded-full bg-emerald-500" />
            Caricamento…
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-gradient-to-b from-zinc-50 via-zinc-50 to-zinc-100 font-sans text-zinc-950 dark:from-black dark:via-black dark:to-zinc-950 dark:text-zinc-50">
      <div className="flex h-full w-full flex-col gap-4 p-4 lg:p-6">
        <header className="shrink-0 rounded-3xl border border-zinc-200 bg-white/80 px-5 py-4 shadow-sm backdrop-blur dark:border-white/10 dark:bg-zinc-950/70">
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-4">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-zinc-950 text-sm font-semibold text-white shadow-sm dark:bg-white dark:text-black">
                RA
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold tracking-tight">Radio Ares</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                  <div className="truncate">{me ? `${me.username} · ${me.role}` : "Offline"}</div>
                  <div className="text-zinc-300 dark:text-white/15">•</div>
                  <div className="flex items-center gap-2">
                    <div
                      className={`h-2 w-2 rounded-full ${
                        connectedPeerCount > 0 ? "bg-emerald-500" : "bg-amber-500"
                      }`}
                    />
                    {connectedPeerCount > 0 ? "Connesso" : "In attesa"}
                  </div>
                  <div className="text-zinc-300 dark:text-white/15">•</div>
                  <div className="truncate">
                    {selectedChannel ? `Canale: ${selectedChannel.name}` : "Canale: nessuno"}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={() => router.refresh()}
                className="h-10 rounded-2xl border border-zinc-200 bg-white px-4 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-white/10 dark:bg-black/40 dark:text-zinc-200 dark:hover:bg-white/10"
              >
                Refresh
              </button>
              <button
                onClick={onLogout}
                className="h-10 rounded-2xl bg-zinc-950 px-4 text-xs font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
              >
                Esci
              </button>
            </div>
          </div>

          {error ? (
            <div className="mt-4 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
              {error}
            </div>
          ) : null}
        </header>

        <main className="grid min-h-0 flex-1 grid-cols-12 gap-4 overflow-y-auto lg:overflow-hidden">
          <section className="col-span-12 min-h-0 lg:col-span-4 xl:col-span-3">
            <div className="flex h-full flex-col overflow-hidden rounded-3xl border border-zinc-200 bg-white/80 shadow-sm backdrop-blur dark:border-white/10 dark:bg-zinc-950/70">
              <div className="shrink-0 border-b border-zinc-200/70 p-4 dark:border-white/10">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold">Canali</div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">
                      {channels.length} totali · {users.length} utenti online
                    </div>
                  </div>
                  {me && canManageUsers(me.role) ? (
                    <div className="flex items-center gap-2">
                      <input
                        value={newChannelName}
                        onChange={(e) => setNewChannelName(e.target.value)}
                        placeholder="Nuovo canale"
                        className="h-9 w-36 rounded-2xl border border-zinc-200 bg-white px-3 text-xs outline-none focus:border-zinc-400 dark:border-white/10 dark:bg-black/40 dark:focus:border-white/30"
                      />
                      <button
                        onClick={onCreateChannel}
                        className="h-9 rounded-2xl bg-zinc-950 px-3 text-xs font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
                      >
                        Crea
                      </button>
                    </div>
                  ) : null}
                </div>

                <div className="mt-3">
                  <input
                    value={channelQuery}
                    onChange={(e) => setChannelQuery(e.target.value)}
                    placeholder="Cerca canale…"
                    className="h-10 w-full rounded-2xl border border-zinc-200 bg-white px-3 text-xs outline-none focus:border-zinc-400 dark:border-white/10 dark:bg-black/40 dark:focus:border-white/30"
                  />
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                <div className="space-y-3">
                  {filteredChannels.map((c) => {
                    const members = usersByChannel.get(c.id) ?? [];
                    const isSelected = c.id === selectedChannelId;
                    const dot =
                      members.length === 0 ? "bg-zinc-300 dark:bg-white/20" : "bg-emerald-500";
                    return (
                      <div
                        key={c.id}
                        className={`rounded-3xl border p-4 transition ${
                          isSelected
                            ? "border-zinc-950 bg-zinc-50 shadow-sm dark:border-white/30 dark:bg-white/5"
                            : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-white/10 dark:bg-zinc-950 dark:hover:bg-white/5"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <div className={`h-2.5 w-2.5 rounded-full ${dot}`} />
                              <div className="truncate text-sm font-semibold">{c.name}</div>
                            </div>
                            <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                              {members.length} online
                            </div>
                          </div>
                          <button
                            onClick={() => onJoin(c.id)}
                            className={`h-10 shrink-0 rounded-2xl px-4 text-xs font-semibold ${
                              isSelected
                                ? "bg-zinc-950 text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
                                : "border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-white/10 dark:bg-black/30 dark:text-zinc-200 dark:hover:bg-white/10"
                            }`}
                          >
                            {isSelected ? "Dentro" : "Entra"}
                          </button>
                        </div>

                        <div className="mt-4 flex flex-wrap gap-2">
                          {members.length ? (
                            members.slice(0, 8).map((u) => (
                              <div
                                key={u.id}
                                className="rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-[11px] text-zinc-700 dark:border-white/10 dark:bg-black/40 dark:text-zinc-200"
                              >
                                {u.username}
                              </div>
                            ))
                          ) : (
                            <div className="text-xs text-zinc-500 dark:text-zinc-400">
                              Nessuno collegato
                            </div>
                          )}
                          {members.length > 8 ? (
                            <div className="rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-[11px] text-zinc-500 dark:border-white/10 dark:bg-black/40 dark:text-zinc-400">
                              +{members.length - 8}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                  {filteredChannels.length === 0 ? (
                    <div className="rounded-3xl border border-zinc-200 bg-white p-6 text-center text-sm text-zinc-600 dark:border-white/10 dark:bg-zinc-950 dark:text-zinc-300">
                      Nessun canale trovato
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </section>

          <section className="col-span-12 min-h-0 lg:col-span-4 xl:col-span-6">
            <div className="flex h-full flex-col overflow-hidden rounded-3xl border border-zinc-200 bg-white/80 shadow-sm backdrop-blur dark:border-white/10 dark:bg-zinc-950/70">
              <div className="shrink-0 border-b border-zinc-200/70 p-4 dark:border-white/10">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">
                      {selectedChannel ? selectedChannel.name : "Nessuna radio selezionata"}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                      <div className="flex items-center gap-2">
                        <div
                          className={`h-2 w-2 rounded-full ${
                            isTalking ? "bg-emerald-500" : "bg-zinc-300 dark:bg-white/20"
                          }`}
                        />
                        {isTalking ? "Trasmissione attiva" : "In ascolto"}
                      </div>
                      <div className="text-zinc-300 dark:text-white/15">•</div>
                      <div>
                        Peers {connectedPeerCount}/{peerEntries.length}
                      </div>
                      <div className="text-zinc-300 dark:text-white/15">•</div>
                      <div className="truncate">
                        PTT: {PTT_OPTIONS.find((o) => o.code === pttKey)?.label}
                      </div>
                    </div>
                  </div>

                  <div className="w-48 shrink-0">
                    <div className="flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
                      <div>Ingresso</div>
                      <div>{Math.round(inputLevelPct * 100)}%</div>
                    </div>
                    <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-white/10">
                      <div
                        className={`h-full rounded-full ${
                          isTalking ? "bg-emerald-500" : "bg-zinc-500 dark:bg-zinc-400"
                        }`}
                        style={{ width: `${Math.round(inputLevelPct * 100)}%` }}
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="min-h-0 flex-1 p-6">
                <div className="flex h-full flex-col items-center justify-between gap-6">
                  <div className="grid w-full grid-cols-2 gap-3 lg:grid-cols-4">
                    <div className="rounded-3xl border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-black/30">
                      <div className="text-[11px] text-zinc-500 dark:text-zinc-400">Microfono</div>
                      <div className="mt-1 truncate text-xs font-semibold">
                        {audioInputs.find((d) => d.deviceId === micDeviceId)?.label || "Default"}
                      </div>
                    </div>
                    <div className="rounded-3xl border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-black/30">
                      <div className="text-[11px] text-zinc-500 dark:text-zinc-400">Uscita</div>
                      <div className="mt-1 truncate text-xs font-semibold">
                        {audioOutputs.find((d) => d.deviceId === outDeviceId)?.label || "Default"}
                      </div>
                    </div>
                    <div className="rounded-3xl border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-black/30">
                      <div className="text-[11px] text-zinc-500 dark:text-zinc-400">Volume</div>
                      <div className="mt-1 text-xs font-semibold">
                        Out {Math.round(outputVolume * 100)}% · In {Math.round(inputGain * 100)}%
                      </div>
                    </div>
                    <div className="rounded-3xl border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-black/30">
                      <div className="text-[11px] text-zinc-500 dark:text-zinc-400">Stato</div>
                      <div className="mt-1 text-xs font-semibold">
                        {connectedPeerCount > 0 ? "Online" : "In attesa"}
                      </div>
                    </div>
                  </div>

                  <div className="flex w-full flex-1 items-center justify-center">
                    <button
                      disabled={!selectedChannelId}
                      onMouseDown={() => void startTalking()}
                      onMouseUp={() => stopTalking()}
                      onMouseLeave={() => stopTalking()}
                      onTouchStart={() => void startTalking()}
                      onTouchEnd={() => stopTalking()}
                      className={`group relative flex h-72 w-72 items-center justify-center rounded-full border text-sm font-semibold shadow-sm transition disabled:cursor-not-allowed disabled:opacity-40 ${
                        isTalking
                          ? "border-emerald-500 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
                          : "border-zinc-200 bg-white text-zinc-950 hover:bg-zinc-50 dark:border-white/10 dark:bg-black/30 dark:text-zinc-50 dark:hover:bg-white/10"
                      }`}
                    >
                      <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_center,rgba(16,185,129,0.15),transparent_60%)] opacity-0 transition group-hover:opacity-100" />
                      <div className="relative flex flex-col items-center gap-2">
                        <div className="text-base font-bold">
                          {selectedChannelId ? "Tieni premuto" : "Seleziona un canale"}
                        </div>
                        <div className="text-xs text-zinc-500 dark:text-zinc-400">
                          {isTalking ? "Trasmettendo…" : "Premi e parla"}
                        </div>
                      </div>
                    </button>
                  </div>

                  <div className="w-full rounded-3xl border border-zinc-200 bg-white p-4 text-xs text-zinc-600 dark:border-white/10 dark:bg-black/30 dark:text-zinc-300">
                    Suggerimento: usa il tasto PTT configurato oppure tieni premuto il pulsante.
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="col-span-12 min-h-0 lg:col-span-4 xl:col-span-3">
            <div className="flex h-full flex-col overflow-hidden rounded-3xl border border-zinc-200 bg-white/80 shadow-sm backdrop-blur dark:border-white/10 dark:bg-zinc-950/70">
              <div className="shrink-0 border-b border-zinc-200/70 p-4 dark:border-white/10">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold">Console</div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">
                      Audio · Utenti · Diagnostica
                    </div>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 rounded-2xl border border-zinc-200 bg-white p-1 dark:border-white/10 dark:bg-black/30">
                  <button
                    onClick={() => setRightTab("audio")}
                    className={`h-9 rounded-xl text-xs font-semibold ${
                      rightTab === "audio"
                        ? "bg-zinc-950 text-white dark:bg-white dark:text-black"
                        : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-white/10"
                    }`}
                  >
                    Audio
                  </button>
                  <button
                    onClick={() => setRightTab("utenti")}
                    className={`h-9 rounded-xl text-xs font-semibold ${
                      rightTab === "utenti"
                        ? "bg-zinc-950 text-white dark:bg-white dark:text-black"
                        : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-white/10"
                    }`}
                  >
                    Utenti
                  </button>
                  <button
                    onClick={() => setRightTab("diagnostica")}
                    className={`h-9 rounded-xl text-xs font-semibold ${
                      rightTab === "diagnostica"
                        ? "bg-zinc-950 text-white dark:bg-white dark:text-black"
                        : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-white/10"
                    }`}
                  >
                    Diagnostica
                  </button>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {rightTab === "audio" ? (
                  <div className="space-y-4">
                    <div className="rounded-3xl border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-black/30">
                      <div className="text-xs font-semibold">Volumi</div>
                      <div className="mt-3 grid grid-cols-2 gap-4">
                        <div>
                          <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                            Uscita
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
                          <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                            Entrata
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
                    </div>

                    <div className="rounded-3xl border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-black/30">
                      <div className="text-xs font-semibold">Dispositivi</div>
                      <div className="mt-3 grid grid-cols-1 gap-3">
                        <div>
                          <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                            Microfono
                          </div>
                          <select
                            value={micDeviceId ?? "default"}
                            onChange={async (e) => {
                              const id = e.target.value;
                              setMicDeviceId(id);
                              await ensureMic(id);
                            }}
                            className="mt-2 h-10 w-full rounded-2xl border border-zinc-200 bg-white px-3 text-xs outline-none focus:border-zinc-400 dark:border-white/10 dark:bg-black/40 dark:focus:border-white/30"
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
                          <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                            Uscita audio
                          </div>
                          <select
                            value={outDeviceId ?? "default"}
                            onChange={(e) => setOutDeviceId(e.target.value)}
                            className="mt-2 h-10 w-full rounded-2xl border border-zinc-200 bg-white px-3 text-xs outline-none focus:border-zinc-400 disabled:opacity-50 dark:border-white/10 dark:bg-black/40 dark:focus:border-white/30"
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
                    </div>

                    <div className="rounded-3xl border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-black/30">
                      <div className="text-xs font-semibold">PTT</div>
                      <div className="mt-3">
                        <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                          Tasto
                        </div>
                        <select
                          value={pttKey}
                          onChange={(e) => setPttKey(e.target.value as PttCode)}
                          className="mt-2 h-10 w-full rounded-2xl border border-zinc-200 bg-white px-3 text-xs outline-none focus:border-zinc-400 dark:border-white/10 dark:bg-black/40 dark:focus:border-white/30"
                        >
                          {PTT_OPTIONS.map((o) => (
                            <option key={o.code} value={o.code}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                ) : null}

                {rightTab === "utenti" ? (
                  <div className="space-y-4">
                    {me && canManageUsers(me.role) ? (
                      <div className="rounded-3xl border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-black/30">
                        <div className="text-xs font-semibold">Gestione utenti</div>
                        <div className="mt-3 space-y-2">
                          {users.map((u) => (
                            <div
                              key={u.id}
                              className="flex items-center justify-between gap-3 rounded-2xl border border-zinc-200 bg-white px-3 py-2 dark:border-white/10 dark:bg-black/30"
                            >
                              <div className="min-w-0">
                                <div className="truncate text-xs font-semibold">{u.username}</div>
                                <div className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                                  {u.role}
                                </div>
                              </div>
                              <select
                                value={u.currentChannelId ?? ""}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  void onMoveUser(u.id, v ? Number(v) : null);
                                }}
                                className="h-9 w-40 rounded-2xl border border-zinc-200 bg-white px-2 text-xs outline-none focus:border-zinc-400 dark:border-white/10 dark:bg-black/40 dark:focus:border-white/30"
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
                                className="h-10 rounded-2xl border border-zinc-200 bg-white px-3 text-xs outline-none focus:border-zinc-400 dark:border-white/10 dark:bg-black/40 dark:focus:border-white/30"
                              />
                              <select
                                value={newUserRole}
                                onChange={(e) =>
                                  setNewUserRole(e.target.value === "user" ? "user" : "moderator")
                                }
                                className="h-10 rounded-2xl border border-zinc-200 bg-white px-3 text-xs outline-none focus:border-zinc-400 dark:border-white/10 dark:bg-black/40 dark:focus:border-white/30"
                              >
                                <option value="moderator">moderator</option>
                                <option value="user">user</option>
                              </select>
                              <input
                                value={newUserPassword}
                                onChange={(e) => setNewUserPassword(e.target.value)}
                                placeholder="Password"
                                type="password"
                                className="h-10 rounded-2xl border border-zinc-200 bg-white px-3 text-xs outline-none focus:border-zinc-400 dark:border-white/10 dark:bg-black/40 dark:focus:border-white/30"
                              />
                              <button
                                onClick={onCreateUser}
                                className="h-10 rounded-2xl bg-zinc-950 px-3 text-xs font-semibold text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
                              >
                                Crea
                              </button>
                            </div>
                            <div className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-500">
                              Il moderator può spostare persone tra radio.
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="rounded-3xl border border-zinc-200 bg-white p-6 text-sm text-zinc-600 dark:border-white/10 dark:bg-black/30 dark:text-zinc-300">
                        Permessi insufficienti
                      </div>
                    )}
                  </div>
                ) : null}

                {rightTab === "diagnostica" ? (
                  <div className="space-y-4">
                    <button
                      onClick={async () => {
                        stopTalking();
                        await ensureMic(micDeviceId);
                      }}
                      className="h-11 w-full rounded-2xl border border-zinc-200 bg-white text-xs font-semibold text-zinc-700 hover:bg-zinc-100 dark:border-white/10 dark:bg-black/30 dark:text-zinc-200 dark:hover:bg-white/10"
                    >
                      Reinizializza audio
                    </button>

                    <div className="rounded-3xl border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-black/30">
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-semibold">Motore audio</div>
                        <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                          Ingresso {Math.round(inputLevelPct * 100)}%
                        </div>
                      </div>
                      <div className="mt-3 space-y-2 text-[11px] text-zinc-600 dark:text-zinc-300">
                        <div className="flex items-center justify-between">
                          <div>AudioContext</div>
                          <div className="text-zinc-500 dark:text-zinc-400">
                            {engineStatus.audioContext}
                          </div>
                        </div>
                        <div className="flex items-center justify-between">
                          <div>Beep</div>
                          <div className="text-zinc-500 dark:text-zinc-400">
                            {engineStatus.beep}
                          </div>
                        </div>
                        <div className="flex items-center justify-between">
                          <div>Mic track</div>
                          <div className="text-zinc-500 dark:text-zinc-400">
                            {engineStatus.micTrack}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-3xl border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-black/30">
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-semibold">WebRTC peers</div>
                        <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                          {connectedPeerCount}/{peerEntries.length} connessi
                        </div>
                      </div>
                      <div className="mt-3 space-y-2">
                        {peerEntries.length ? (
                          peerEntries.map(([uid, s]) => (
                            <div
                              key={uid}
                              className="flex items-center justify-between gap-3 rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-[11px] text-zinc-700 dark:border-white/10 dark:bg-black/30 dark:text-zinc-200"
                            >
                              <div className="truncate">User {uid}</div>
                              <div className="text-zinc-500 dark:text-zinc-400">
                                {s.connectionState}/{s.iceConnectionState}
                              </div>
                            </div>
                          ))
                        ) : (
                          <div className="rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-[11px] text-zinc-500 dark:border-white/10 dark:bg-black/30 dark:text-zinc-400">
                            Nessun peer
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

