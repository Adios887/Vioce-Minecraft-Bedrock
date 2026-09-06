/**
 * ==========================================================
 *  My Voice Chat - Frontend script
 * ==========================================================
 * ทำหน้าที่:
 *  - เดินเรื่องตามขั้นตอน: เลือกโหมด -> กรอกรหัส -> ชื่อผู้เล่น -> ตั้งค่าไมค์
 *  - เชื่อมต่อ WebSocket ไปหาแบ็กเอนด์ (path /site)
 *  - ขอสิทธิ์ไมค์ + วัดระดับเสียง (มิเตอร์ + ตรวจจับว่า "กำลังพูด" อยู่ไหม)
 *  - เปิดการเชื่อมต่อ WebRTC (P2P) กับผู้เล่นคนอื่นในกลุ่มเดียวกัน
 *    เพื่อส่งเสียงจริงระหว่างเบราว์เซอร์
 *  - ถ้าเซิร์ฟเวอร์แจ้งว่า Minecraft หลุดการเชื่อมต่อ -> แสดง bubble
 *    แจ้งเตือนแล้วเคลียร์ทุกอย่าง กลับไปเริ่มใหม่
 * ==========================================================
 */

const els = {
  stepMode: document.getElementById("step-mode"),
  stepCode: document.getElementById("step-code"),
  stepName: document.getElementById("step-name"),
  stepSettings: document.getElementById("step-settings"),
  serverFields: document.getElementById("server-fields"),
  modeNext: document.getElementById("mode-next"),
  codeInput: document.getElementById("code-input"),
  codeError: document.getElementById("code-error"),
  codeNext: document.getElementById("code-next"),
  nameInput: document.getElementById("name-input"),
  nameNext: document.getElementById("name-next"),
  connectedName: document.getElementById("connected-name"),
  micMeterFill: document.getElementById("mic-meter-fill"),
  muteBtn: document.getElementById("mute-btn"),
  muteLabel: document.getElementById("mute-label"),
  hearVolume: document.getElementById("hear-volume"),
  speakVolume: document.getElementById("speak-volume"),
  hearDistance: document.getElementById("hear-distance"),
  speakDistance: document.getElementById("speak-distance"),
  disconnectBtn: document.getElementById("disconnect-btn"),
  bubble: document.getElementById("disconnect-bubble"),
  bubbleRestart: document.getElementById("bubble-restart"),
};

const state = {
  mode: null, // "world" | "server"
  code: "",
  playerName: "",
  muted: false,
  ws: null,
  localStream: null,
  audioCtx: null,
  analyser: null,
  peers: new Map(), // playerName -> RTCPeerConnection
  positions: {},
};

function showStep(step) {
  [els.stepMode, els.stepCode, els.stepName, els.stepSettings].forEach((s) => s.classList.add("hidden"));
  step.classList.remove("hidden");
}

// ---------------- ขั้นที่ 0: เลือกโหมด ----------------
document.querySelectorAll(".choice").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".choice").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    state.mode = btn.dataset.mode;
    els.serverFields.classList.toggle("hidden", state.mode !== "server");
    els.modeNext.disabled = false;
  });
});
els.modeNext.addEventListener("click", () => showStep(els.stepCode));

// ---------------- ขั้นที่ 1: กรอกรหัส ----------------
els.codeInput.addEventListener("input", () => {
  els.codeInput.value = els.codeInput.value.replace(/\D/g, "").slice(0, 6);
});
els.codeNext.addEventListener("click", () => {
  if (els.codeInput.value.length !== 6) {
    els.codeError.textContent = "กรุณากรอกรหัส 6 หลักให้ครบ";
    els.codeError.classList.remove("hidden");
    return;
  }
  state.code = els.codeInput.value;
  showStep(els.stepName);
});

// ---------------- ขั้นที่ 2: ชื่อผู้เล่น ----------------
els.nameNext.addEventListener("click", () => {
  const name = els.nameInput.value.trim();
  if (!name) return;
  state.playerName = name;
  connectToBackend();
});

function connectToBackend() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  state.ws = new WebSocket(`${proto}//${location.host}/site`);

  state.ws.addEventListener("open", () => {
    state.ws.send(JSON.stringify({ type: "verify", code: state.code, playerName: state.playerName }));
  });

  state.ws.addEventListener("message", (ev) => handleServerMessage(JSON.parse(ev.data)));

  state.ws.addEventListener("close", () => showDisconnectBubble());
}

function handleServerMessage(msg) {
  if (msg.type === "verified") {
    els.connectedName.textContent = msg.playerName;
    showStep(els.stepSettings);
    startMic();
    return;
  }
  if (msg.type === "verify_failed") {
    els.codeError.textContent = msg.reason || "ยืนยันไม่สำเร็จ";
    els.codeError.classList.remove("hidden");
    showStep(els.stepCode);
    return;
  }
  if (msg.type === "peers") {
    syncPeers(msg.peers);
    return;
  }
  if (msg.type === "signal") {
    handleSignal(msg.from, msg.data);
    return;
  }
  if (msg.type === "peer_left") {
    closePeer(msg.playerName);
    return;
  }
  if (msg.type === "positions") {
    state.positions = msg.positions;
    updateSpatialVolumes();
    return;
  }
  if (msg.type === "disconnected") {
    showDisconnectBubble();
    return;
  }
}

// ---------------- ไมค์: ขอสิทธิ์ + วัดระดับเสียง ----------------
async function startMic() {
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    els.muteLabel.textContent = "ไม่สามารถเข้าถึงไมค์ได้";
    return;
  }

  state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = state.audioCtx.createMediaStreamSource(state.localStream);
  state.analyser = state.audioCtx.createAnalyser();
  state.analyser.fftSize = 512;
  source.connect(state.analyser);

  const data = new Uint8Array(state.analyser.frequencyBinCount);
  let wasTalking = false;

  function tick() {
    state.analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    const level = Math.min(100, Math.round((avg / 128) * 100));
    els.micMeterFill.style.width = `${level}%`;

    const talking = !state.muted && level > 8;
    if (talking !== wasTalking) {
      wasTalking = talking;
      state.ws?.send(JSON.stringify({ type: "talking", talking, muted: state.muted }));
    }
    requestAnimationFrame(tick);
  }
  tick();
}

els.muteBtn.addEventListener("click", () => {
  state.muted = !state.muted;
  els.muteBtn.classList.toggle("muted", state.muted);
  els.muteLabel.textContent = state.muted ? "ไมค์ปิดอยู่" : "ไมค์เปิดอยู่";
  state.localStream?.getAudioTracks().forEach((t) => (t.enabled = !state.muted));
  state.ws?.send(JSON.stringify({ type: "mute", muted: state.muted }));
});

// ---------------- WebRTC mesh ระหว่างผู้เล่นในกลุ่มเดียวกัน ----------------
const RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function syncPeers(names) {
  // เปิดการเชื่อมต่อกับคนที่ยังไม่เคยเชื่อม
  names.forEach((name) => {
    if (!state.peers.has(name)) createPeer(name, state.playerName < name);
  });
  // ปิดการเชื่อมต่อกับคนที่ไม่อยู่ในกลุ่มแล้ว
  for (const name of state.peers.keys()) {
    if (!names.includes(name)) closePeer(name);
  }
}

function createPeer(name, isInitiator) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.peers.set(name, pc);

  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => pc.addTrack(track, state.localStream));
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      state.ws?.send(JSON.stringify({ type: "signal", to: name, data: { candidate: e.candidate } }));
    }
  };

  pc.ontrack = (e) => {
    let audioEl = document.getElementById(`audio-${name}`);
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.id = `audio-${name}`;
      audioEl.autoplay = true;
      document.body.appendChild(audioEl);
    }
    audioEl.srcObject = e.streams[0];
  };

  if (isInitiator) {
    pc.onnegotiationneeded = async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      state.ws?.send(JSON.stringify({ type: "signal", to: name, data: { sdp: pc.localDescription } }));
    };
  }

  return pc;
}

async function handleSignal(from, data) {
  let pc = state.peers.get(from);
  if (!pc) pc = createPeer(from, false);

  if (data.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    if (data.sdp.type === "offer") {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      state.ws?.send(JSON.stringify({ type: "signal", to: from, data: { sdp: pc.localDescription } }));
    }
  } else if (data.candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch {
      /* ข้ามถ้าเพิ่มไม่ทัน */
    }
  }
}

function closePeer(name) {
  const pc = state.peers.get(name);
  if (pc) {
    pc.close();
    state.peers.delete(name);
  }
  const audioEl = document.getElementById(`audio-${name}`);
  audioEl?.remove();
}

// ---------------- ระยะเสียงตามตำแหน่ง (proximity) ----------------
// TODO: ตอนนี้เป็น logic แบบง่าย (เทียบระยะห่างตรง ๆ ไม่รวม dimension)
// ถ้าต้องการความแม่นยำระดับ production ควรเทียบ dimension ด้วยและ
// ทำ interpolation ตำแหน่งระหว่างแพ็กเก็ตที่ได้รับ
function updateSpatialVolumes() {
  const me = state.positions[state.playerName];
  if (!me) return;
  const hearDist = Number(els.hearDistance.value);
  const hearVol = Number(els.hearVolume.value) / 100;

  for (const [name, pc] of state.peers.entries()) {
    const other = state.positions[name];
    const audioEl = document.getElementById(`audio-${name}`);
    if (!other || !audioEl) continue;
    const dx = me.x - other.x, dy = me.y - other.y, dz = me.z - other.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const falloff = Math.max(0, 1 - dist / hearDist);
    audioEl.volume = Math.min(1, falloff * hearVol);
  }
}
els.hearVolume.addEventListener("input", updateSpatialVolumes);
els.hearDistance.addEventListener("input", updateSpatialVolumes);

// ---------------- ตัดการเชื่อมต่อ / bubble แจ้งเตือน ----------------
els.disconnectBtn.addEventListener("click", () => resetAll());
els.bubbleRestart.addEventListener("click", () => resetAll());

function showDisconnectBubble() {
  els.bubble.classList.remove("hidden");
}

function resetAll() {
  state.ws?.close();
  for (const name of [...state.peers.keys()]) closePeer(name);
  state.localStream?.getTracks().forEach((t) => t.stop());
  state.audioCtx?.close();

  state.mode = null;
  state.code = "";
  state.playerName = "";
  state.muted = false;
  state.positions = {};

  els.codeInput.value = "";
  els.nameInput.value = "";
  els.codeError.classList.add("hidden");
  els.bubble.classList.add("hidden");
  document.querySelectorAll(".choice").forEach((b) => b.classList.remove("selected"));
  els.serverFields.classList.add("hidden");
  els.modeNext.disabled = true;

  showStep(els.stepMode);
}
