/* =========================================================================
   PODVERSE — app.js
   Backend: cloud-capsule-hub key/value store (GET/POST/PUT/DELETE by key)
   No listing endpoint exists on that API, so we keep two "index" documents
   (idx_users, idx_projects) that hold summaries, and store the heavy
   payloads (actual code, per-project presence, webrtc signaling) under
   their own keys. Last-write-wins — fine for a hobby-scale demo, not for
   heavy concurrent writers.
   ========================================================================= */

const CONFIG = {
  base: "https://cloud-capsule-hub.lovable.app/api/public/v1/9aa9a024-2cc1-4394-b5bc-d93d341a5dad",
  token: "sk_d554bb50ee2036d413f019e4458de27a72ce7851d51b7a97"
};

/* ---------------------------------------------------------------------- */
/* KV client                                                              */
/* ---------------------------------------------------------------------- */
const KV = {
  async _req(method, key, body) {
    const opts = {
      method,
      headers: { "Authorization": `Bearer ${CONFIG.token}` }
    };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${CONFIG.base}/${encodeURIComponent(key)}`, opts);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`KV ${method} ${key} failed: ${res.status}`);
    if (method === "DELETE") return true;
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  },
  get(key) { return this._req("GET", key); },
  put(key, val) { return this._req("PUT", key, val); },
  post(key, val) { return this._req("POST", key, val); },
  del(key) { return this._req("DELETE", key); }
};

/* ---------------------------------------------------------------------- */
/* Small utils                                                            */
/* ---------------------------------------------------------------------- */
const Util = {
  uid(n = 12) {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let s = "";
    for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  },
  sessionCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = "";
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  },
  async sha256(str) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  },
  esc(s = "") {
    return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  },
  now() { return Date.now(); },
  colorFor(seed) {
    const palette = [
      ["#7c5cff", "#ff6b5f"], ["#3ee6b0", "#7c5cff"], ["#ff6b5f", "#ffb45c"],
      ["#5ad0ff", "#7c5cff"], ["#a78bff", "#ff6b5f"], ["#3ee6b0", "#5ad0ff"]
    ];
    let h = 0;
    for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return palette[h % palette.length];
  },
  toast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove("show"), 2600);
  }
};

/* ---------------------------------------------------------------------- */
/* Data layer                                                             */
/* ---------------------------------------------------------------------- */
const DB = {
  async getUsers() { return (await KV.get("idx_users")) || {}; },
  async saveUsers(obj) { return KV.put("idx_users", obj); },

  async getProjectsIndex() { return (await KV.get("idx_projects")) || {}; },
  async saveProjectsIndex(obj) { return KV.put("idx_projects", obj); },

  async getProjectCode(id) { return (await KV.get(`proj_${id}`)) || { html: "", css: "", js: "", py: "" }; },
  async saveProjectCode(id, code) { return KV.put(`proj_${id}`, code); },
  async deleteProjectCode(id) { return KV.del(`proj_${id}`); },

  async getPresence(id) { return (await KV.get(`presence_${id}`)) || {}; },
  async savePresence(id, map) { return KV.put(`presence_${id}`, map); }
};

/* ---------------------------------------------------------------------- */
/* Auth                                                                   */
/* ---------------------------------------------------------------------- */
const Auth = {
  current: null, // {id, username}

  init() {
    const saved = localStorage.getItem("pv_session");
    if (saved) { try { this.current = JSON.parse(saved); } catch { /* noop */ } }
  },

  persist() { localStorage.setItem("pv_session", JSON.stringify(this.current)); },

  async register(username, password) {
    username = username.trim();
    if (username.length < 3) throw new Error("Benutzername braucht min. 3 Zeichen.");
    if (password.length < 4) throw new Error("Passwort braucht min. 4 Zeichen.");
    const users = await DB.getUsers();
    if (users[username.toLowerCase()]) throw new Error("Benutzername bereits vergeben.");
    const salt = Util.uid(8);
    const hash = await Util.sha256(salt + password);
    const id = Util.uid(10);
    users[username.toLowerCase()] = { id, username, salt, hash, createdAt: Util.now() };
    await DB.saveUsers(users);
    this.current = { id, username };
    this.persist();
    return this.current;
  },

  async login(username, password) {
    const users = await DB.getUsers();
    const rec = users[username.trim().toLowerCase()];
    if (!rec) throw new Error("Konto nicht gefunden.");
    const hash = await Util.sha256(rec.salt + password);
    if (hash !== rec.hash) throw new Error("Falsches Passwort.");
    this.current = { id: rec.id, username: rec.username };
    this.persist();
    return this.current;
  },

  async loginWithCode(code) {
    code = code.trim().toUpperCase();
    const rec = await KV.get(`logincode_${code}`);
    if (!rec) throw new Error("Code ungültig oder abgelaufen.");
    const users = await DB.getUsers();
    const user = users[rec.username.toLowerCase()];
    if (!user) throw new Error("Konto nicht mehr vorhanden.");
    this.current = { id: user.id, username: user.username };
    this.persist();
    return this.current;
  },

  async makeLoginCode() {
    if (!this.current) throw new Error("Nicht eingeloggt.");
    const code = Util.uid(4).toUpperCase() + "-" + Util.uid(4).toUpperCase();
    await KV.put(`logincode_${code}`, { username: this.current.username, createdAt: Util.now() });
    return code;
  },

  logout() {
    this.current = null;
    localStorage.removeItem("pv_session");
  }
};

/* ---------------------------------------------------------------------- */
/* Projects                                                               */
/* ---------------------------------------------------------------------- */
const Projects = {
  async create({ name, desc, tags, multiplayer, code }) {
    if (!Auth.current) throw new Error("Bitte zuerst einloggen.");
    if (!name.trim()) throw new Error("Name fehlt.");
    const idx = await DB.getProjectsIndex();
    const id = Util.uid(10);
    idx[id] = {
      id, name: name.trim(), desc: desc.trim(),
      tags: tags.filter(Boolean).slice(0, 4),
      creatorId: Auth.current.id, creatorName: Auth.current.username,
      multiplayer: !!multiplayer,
      plays: 0, favorites: 0,
      createdAt: Util.now(), updatedAt: Util.now()
    };
    await DB.saveProjectsIndex(idx);
    await DB.saveProjectCode(id, code);
    return id;
  },

  async update(id, { name, desc, tags, multiplayer, code }) {
    const idx = await DB.getProjectsIndex();
    const p = idx[id];
    if (!p) throw new Error("Pod nicht gefunden.");
    if (p.creatorId !== Auth.current?.id) throw new Error("Nur der Ersteller kann bearbeiten.");
    Object.assign(p, {
      name: name.trim(), desc: desc.trim(),
      tags: tags.filter(Boolean).slice(0, 4),
      multiplayer: !!multiplayer, updatedAt: Util.now()
    });
    await DB.saveProjectsIndex(idx);
    await DB.saveProjectCode(id, code);
  },

  async remove(id) {
    const idx = await DB.getProjectsIndex();
    const p = idx[id];
    if (!p) return;
    if (p.creatorId !== Auth.current?.id) throw new Error("Nur der Ersteller kann löschen.");
    delete idx[id];
    await DB.saveProjectsIndex(idx);
    await DB.deleteProjectCode(id);
  },

  async bumpPlays(id) {
    const idx = await DB.getProjectsIndex();
    if (idx[id]) { idx[id].plays = (idx[id].plays || 0) + 1; await DB.saveProjectsIndex(idx); }
  },

  async toggleFavorite(id) {
    const favs = JSON.parse(localStorage.getItem("pv_favs") || "[]");
    const has = favs.includes(id);
    const idx = await DB.getProjectsIndex();
    if (!idx[id]) return has;
    idx[id].favorites = Math.max(0, (idx[id].favorites || 0) + (has ? -1 : 1));
    await DB.saveProjectsIndex(idx);
    const next = has ? favs.filter(f => f !== id) : [...favs, id];
    localStorage.setItem("pv_favs", JSON.stringify(next));
    return !has;
  },

  isFavorite(id) {
    return JSON.parse(localStorage.getItem("pv_favs") || "[]").includes(id);
  },

  recordInterest(tags) {
    const map = JSON.parse(localStorage.getItem("pv_interest") || "{}");
    for (const t of tags) map[t] = (map[t] || 0) + 1;
    localStorage.setItem("pv_interest", JSON.stringify(map));
  }
};

/* ---------------------------------------------------------------------- */
/* Presence / live counts (heartbeat, no listing endpoint needed)         */
/* ---------------------------------------------------------------------- */
const Presence = {
  mySid: Util.uid(8),
  timer: null,

  prune(map) {
    const cutoff = Util.now() - 40000;
    for (const k in map) if (map[k] < cutoff) delete map[k];
    return map;
  },

  async countFor(projectId) {
    const map = this.prune(await DB.getPresence(projectId));
    return Object.keys(map).length;
  },

  async beat(projectId) {
    const map = this.prune(await DB.getPresence(projectId));
    map[this.mySid] = Util.now();
    await DB.savePresence(projectId, map);
    return Object.keys(map).length;
  },

  async leave(projectId) {
    const map = this.prune(await DB.getPresence(projectId));
    delete map[this.mySid];
    await DB.savePresence(projectId, map);
  },

  startHeartbeat(projectId, onCount) {
    this.stopHeartbeat();
    const tick = async () => { try { onCount(await this.beat(projectId)); } catch { /* offline, ignore */ } };
    tick();
    this.timer = setInterval(tick, 12000);
  },

  stopHeartbeat(projectId) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (projectId) this.leave(projectId);
  }
};

/* ---------------------------------------------------------------------- */
/* WebRTC multiplayer (host relays messages between joined peers)         */
/* Signaling channel: the KV store, via short-lived polling.              */
/* ---------------------------------------------------------------------- */
const RTC_ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

const Multiplayer = {
  active: false,
  isHost: false,
  code: null,
  role: null,
  peers: new Map(), // slot -> {pc, channel, connected}
  hostConn: null,   // joiner's connection object {pc, channel}
  pollTimer: null,
  onPeerChange: null,
  onStatus: null,
  onGameMessage: null, // (fromLabel, data)

  async host(projectId, statusCb, peerCb) {
    this.reset();
    this.isHost = true; this.active = true; this.role = "host";
    this.code = Util.sessionCode();
    this.onStatus = statusCb; this.onPeerChange = peerCb;
    await KV.put(`mp_${this.code}_host`, { ready: true, projectId, host: Auth.current?.username || "Gast", ts: Util.now() });
    this.usedSlots = new Set();
    this.pollTimer = setInterval(() => this._hostPoll(), 1500);
    statusCb(`Session ${this.code} • warte auf Mitspieler …`);
    return this.code;
  },

  async _hostPoll() {
    if (!this.active) return;
    for (let slot = 0; slot < 20; slot++) {
      if (this.usedSlots.has(slot)) continue;
      let offer;
      try { offer = await KV.get(`mp_${this.code}_offer_${slot}`); } catch { continue; }
      if (!offer) continue;
      this.usedSlots.add(slot);
      this._acceptJoiner(slot, offer.sdp).catch(() => {});
    }
  },

  async _acceptJoiner(slot, offerSdp) {
    const pc = new RTCPeerConnection(RTC_ICE);
    const rec = { pc, channel: null, connected: false, label: `Spieler ${slot + 1}` };
    this.peers.set(slot, rec);

    pc.ondatachannel = (ev) => {
      rec.channel = ev.channel;
      ev.channel.onopen = () => { rec.connected = true; this.onPeerChange?.(this.peerList()); };
      ev.channel.onclose = () => { rec.connected = false; this.peers.delete(slot); this.onPeerChange?.(this.peerList()); };
      ev.channel.onmessage = (m) => this._relayFromPeer(slot, m.data);
    };

    await pc.setRemoteDescription(offerSdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this._waitIce(pc);
    await KV.put(`mp_${this.code}_answer_${slot}`, { sdp: pc.localDescription });
    this.onStatus?.(`Session ${this.code} • ${this.peers.size} verbunden`);
  },

  async join(code, statusCb, peerCb) {
    this.reset();
    this.isHost = false; this.active = true; this.role = "joiner";
    this.code = code.trim().toUpperCase();
    this.onStatus = statusCb; this.onPeerChange = peerCb;

    const hostDoc = await KV.get(`mp_${this.code}_host`);
    if (!hostDoc) throw new Error("Session-Code nicht gefunden.");

    const slot = Math.floor(Math.random() * 5000);
    const pc = new RTCPeerConnection(RTC_ICE);
    const channel = pc.createDataChannel("game");
    this.hostConn = { pc, channel, slot };

    channel.onopen = () => { statusCb(`Verbunden mit ${this.code}`); peerCb([{ label: "Host", connected: true }]); };
    channel.onclose = () => { statusCb(`Verbindung getrennt`); peerCb([]); };
    channel.onmessage = (m) => this._relayFromHost(m.data);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this._waitIce(pc);
    await KV.put(`mp_${this.code}_offer_${slot}`, { sdp: pc.localDescription });

    statusCb(`Sende Beitritts-Anfrage …`);
    const answer = await this._pollFor(`mp_${this.code}_answer_${slot}`, 25000);
    if (!answer) throw new Error("Host hat nicht geantwortet (Timeout).");
    await pc.setRemoteDescription(answer.sdp);
    statusCb(`Verbinde …`);
  },

  async _pollFor(key, timeoutMs) {
    const start = Util.now();
    while (Util.now() - start < timeoutMs) {
      const v = await KV.get(key).catch(() => null);
      if (v) return v;
      await new Promise(r => setTimeout(r, 1200));
    }
    return null;
  },

  _waitIce(pc) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise(resolve => {
      const timeout = setTimeout(resolve, 2500);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === "complete") { clearTimeout(timeout); resolve(); }
      };
    });
  },

  peerList() {
    return [...this.peers.values()].map(p => ({ label: p.label, connected: p.connected }));
  },

  // send from local game (iframe) out to network
  send(data) {
    if (!this.active) return;
    if (this.isHost) {
      for (const rec of this.peers.values()) {
        if (rec.connected) try { rec.channel.send(JSON.stringify({ from: "host", data })); } catch {}
      }
    } else if (this.hostConn?.channel?.readyState === "open") {
      try { this.hostConn.channel.send(JSON.stringify({ from: "me", data })); } catch {}
    }
  },

  _relayFromPeer(slot, raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    // deliver to local iframe
    this.onGameMessage?.(`Spieler ${slot + 1}`, msg.data);
    // relay to every other connected peer (star topology)
    for (const [otherSlot, rec] of this.peers.entries()) {
      if (otherSlot === slot || !rec.connected) continue;
      try { rec.channel.send(JSON.stringify({ from: `Spieler ${slot + 1}`, data: msg.data })); } catch {}
    }
  },

  _relayFromHost(raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    this.onGameMessage?.(msg.from || "Host", msg.data);
  },

  reset() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const rec of this.peers.values()) { try { rec.pc.close(); } catch {} }
    this.peers.clear();
    if (this.hostConn) { try { this.hostConn.pc.close(); } catch {} this.hostConn = null; }
    this.active = false; this.isHost = false; this.code = null; this.role = null;
  }
};

/* ---------------------------------------------------------------------- */
/* Sandbox runner — builds the iframe document for a project              */
/* ---------------------------------------------------------------------- */
const Sandbox = {
  build(code, meta) {
    const hasPy = !!(code.py && code.py.trim());
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#fff;}${code.css || ""}</style>
</head><body>
${code.html || ""}
<script>
  // ---- Podverse bridge injected for the running pod ----
  window.Podverse = {
    player: ${JSON.stringify({ username: Auth.current?.username || "Gast" })},
    multiplayer: {
      enabled: ${meta.multiplayer ? "true" : "false"},
      isHost: ${meta.mpIsHost ? "true" : "false"},
      sessionCode: ${JSON.stringify(meta.mpCode || null)},
      send(data){ parent.postMessage({ __pv: true, type:'mp-send', data }, '*'); },
      onMessage(cb){ window.__pvOnMessage = cb; },
      onPeers(cb){ window.__pvOnPeers = cb; }
    }
  };
  window.addEventListener('message', (e) => {
    if (!e.data || !e.data.__pv) return;
    if (e.data.type === 'mp-message' && window.__pvOnMessage) window.__pvOnMessage(e.data.from, e.data.data);
    if (e.data.type === 'mp-peers' && window.__pvOnPeers) window.__pvOnPeers(e.data.peers);
  });
<\/script>
${hasPy ? `
<script src="https://cdn.jsdelivr.net/pyodide/v0.26.1/full/pyodide.js"><\/script>
<script>
  (async () => {
    try {
      const pyodide = await loadPyodide();
      await pyodide.runPythonAsync(${JSON.stringify(code.py)});
    } catch (e) { console.error('Python-Fehler:', e); }
  })();
<\/script>` : ""}
<script>${code.js || ""}<\/script>
</body></html>`;
  }
};

/* =========================================================================
   UI layer
   ========================================================================= */
const UI = {
  els: {},
  currentEditingId: null,
  currentDetailId: null,
  playingId: null,

  init() {
    Auth.init();
    this.cacheEls();
    this.wireGlobal();
    this.wireAuth();
    this.wireCreate();
    this.renderAccountSlot();
    this.loadHome();
    this.startGlobalLiveCounter();
  },

  cacheEls() {
    this.els.searchInput = document.getElementById("searchInput");
    this.els.topGrid = document.getElementById("topGrid");
    this.els.forYouGrid = document.getElementById("forYouGrid");
    this.els.searchGrid = document.getElementById("searchGrid");
    this.els.searchRow = document.getElementById("searchRow");
    this.els.searchHint = document.getElementById("searchHint");
  },

  goHome() {
    this.els.searchInput.value = "";
    this.els.searchRow.hidden = true;
  },

  toggle(id, show) { document.getElementById(id).hidden = !show; },

  wireGlobal() {
    document.querySelectorAll("[data-close]").forEach(btn => {
      btn.addEventListener("click", () => this.toggle(btn.dataset.close, false));
    });
    document.querySelectorAll(".overlay").forEach(ov => {
      ov.addEventListener("click", (e) => { if (e.target === ov) ov.hidden = true; });
    });
    document.getElementById("createBtn").addEventListener("click", () => {
      if (!Auth.current) { Util.toast("Bitte zuerst einloggen."); this.toggle("authOverlay", true); return; }
      this.openCreate(null);
    });
    let debounce;
    this.els.searchInput.addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => this.runSearch(this.els.searchInput.value.trim()), 200);
    });
    document.getElementById("exitPlayBtn").addEventListener("click", () => this.exitPlay());
  },

  /* ---------------- Auth UI ---------------- */
  wireAuth() {
    document.querySelectorAll(".tab").forEach(tab => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach(t => t.classList.remove("is-active"));
        document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("is-active"));
        tab.classList.add("is-active");
        document.querySelector(`.tab-panel[data-panel="${tab.dataset.tab}"]`).classList.add("is-active");
        if (tab.dataset.tab === "qr") this.renderQrPanel();
      });
    });

    document.getElementById("loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = document.getElementById("loginError"); err.textContent = "";
      try {
        await Auth.login(document.getElementById("loginUser").value, document.getElementById("loginPass").value);
        this.toggle("authOverlay", false);
        this.renderAccountSlot();
        Util.toast(`Willkommen zurück, ${Auth.current.username}!`);
      } catch (ex) { err.textContent = ex.message; }
    });

    document.getElementById("registerForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = document.getElementById("regError"); err.textContent = "";
      try {
        await Auth.register(document.getElementById("regUser").value, document.getElementById("regPass").value);
        this.toggle("authOverlay", false);
        this.renderAccountSlot();
        Util.toast(`Konto erstellt — willkommen, ${Auth.current.username}!`);
      } catch (ex) { err.textContent = ex.message; }
    });

    document.getElementById("qrLoginBtn").addEventListener("click", async () => {
      const err = document.getElementById("qrError"); err.textContent = "";
      try {
        await Auth.loginWithCode(document.getElementById("qrCodeInput").value);
        this.toggle("authOverlay", false);
        this.renderAccountSlot();
        Util.toast(`Eingeloggt als ${Auth.current.username}.`);
      } catch (ex) { err.textContent = ex.message; }
    });
  },

  async renderQrPanel() {
    const area = document.getElementById("qrLoginArea");
    if (!Auth.current) { area.textContent = "Melde dich zuerst normal an, um deinen QR-Login-Code zu sehen."; return; }
    area.innerHTML = "Code wird erzeugt …";
    const code = await Auth.makeLoginCode();
    area.innerHTML = `<div id="qrCanvas"></div><div class="qr-code-text">${code}</div><div style="margin-top:6px;">Gültig für dieses Gerät-Setup. Auf einem anderen Gerät einfach eintragen.</div>`;
    this.ensureQrLib(() => {
      new QRCode(document.getElementById("qrCanvas"), { text: code, width: 150, height: 150, colorDark: "#14122a", colorLight: "#ffffff" });
    });
  },

  ensureQrLib(cb) {
    if (window.QRCode) return cb();
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
    s.onload = cb;
    document.head.appendChild(s);
  },

  renderAccountSlot() {
    const slot = document.getElementById("accountSlot");
    if (!Auth.current) {
      slot.innerHTML = `<button class="btn btn--primary" id="loginOpenBtn">Anmelden</button>`;
      document.getElementById("loginOpenBtn").addEventListener("click", () => this.toggle("authOverlay", true));
      return;
    }
    const initial = Auth.current.username[0].toUpperCase();
    slot.innerHTML = `<div class="account-chip" id="accountChip">
      <span class="account-chip__avatar">${initial}</span>
      <span>${Util.esc(Auth.current.username)}</span>
    </div>`;
    document.getElementById("accountChip").addEventListener("click", () => {
      if (confirm("Abmelden?")) { Auth.logout(); this.renderAccountSlot(); this.goHome(); Util.toast("Abgemeldet."); }
    });
  },

  /* ---------------- Home rendering ---------------- */
  async loadHome() {
    const idx = await DB.getProjectsIndex().catch(() => ({}));
    const list = Object.values(idx);

    const top = [...list].sort((a, b) => (b.plays + b.favorites * 2) - (a.plays + a.favorites * 2)).slice(0, 10);
    this.renderGrid(this.els.topGrid, top, "Noch keine Pods — sei der Erste und erstelle einen!");

    const interest = JSON.parse(localStorage.getItem("pv_interest") || "{}");
    const forYou = [...list].sort((a, b) => {
      const scoreA = a.tags.reduce((s, t) => s + (interest[t] || 0), 0) + Math.random() * 0.3;
      const scoreB = b.tags.reduce((s, t) => s + (interest[t] || 0), 0) + Math.random() * 0.3;
      return scoreB - scoreA;
    }).slice(0, 10);
    this.renderGrid(this.els.forYouGrid, forYou, "Spiel ein paar Pods, damit wir deinen Geschmack lernen können.");

    // live counts (best effort, non-blocking)
    for (const p of [...top, ...forYou]) this.attachLiveCount(p.id);
  },

  async runSearch(q) {
    if (!q) { this.els.searchRow.hidden = true; return; }
    const idx = await DB.getProjectsIndex().catch(() => ({}));
    const needle = q.toLowerCase().replace(/^#/, "");
    const results = Object.values(idx).filter(p =>
      p.name.toLowerCase().includes(needle) ||
      p.desc.toLowerCase().includes(needle) ||
      p.creatorName.toLowerCase().includes(needle) ||
      p.tags.some(t => t.toLowerCase().includes(needle))
    );
    this.els.searchRow.hidden = false;
    this.els.searchHint.textContent = `${results.length} Treffer für „${q}“`;
    this.renderGrid(this.els.searchGrid, results, "Keine Pods gefunden.");
  },

  renderGrid(el, list, emptyMsg) {
    if (!list.length) { el.innerHTML = `<p class="empty-note">${emptyMsg}</p>`; return; }
    el.innerHTML = list.map(p => this.cardHtml(p)).join("");
    el.querySelectorAll(".pod-card").forEach(card => {
      card.addEventListener("click", () => this.openDetail(card.dataset.id));
    });
  },

  cardHtml(p) {
    const [c1, c2] = Util.colorFor(p.id);
    return `<div class="pod-card" data-id="${p.id}">
      <div class="pod-card__thumb" style="background:linear-gradient(135deg,${c1},${c2})">${Util.esc(p.name[0]?.toUpperCase() || "?")}</div>
      <div class="pod-card__title">${Util.esc(p.name)}</div>
      <div class="pod-card__desc">${Util.esc(p.desc || "Keine Beschreibung.")}</div>
      <div class="pod-card__tags">${p.tags.map(t => `<span class="tag-chip">#${Util.esc(t)}</span>`).join("")}</div>
      <div class="pod-card__meta">
        <span>von ${Util.esc(p.creatorName)}</span>
        <span class="live-inline" data-live="${p.id}">${p.multiplayer ? '<span class="mp-badge">⬡ Multiplayer</span>' : ""}</span>
      </div>
    </div>`;
  },

  async attachLiveCount(id) {
    try {
      const n = await Presence.countFor(id);
      const el = document.querySelector(`[data-live="${id}"]`);
      if (el && n > 0) el.innerHTML += ` <span class="live-counter" style="padding:2px 8px;"><span class="live-dot"></span>${n}</span>`;
    } catch { /* ignore */ }
  },

  startGlobalLiveCounter() {
    // approximate: sum presence of currently rendered cards, refreshed periodically
    const tick = async () => {
      const cards = document.querySelectorAll(".pod-card");
      let total = 0;
      for (const c of cards) { try { total += await Presence.countFor(c.dataset.id); } catch {} }
      document.getElementById("globalLiveCount").textContent = total;
    };
    tick();
    setInterval(tick, 15000);
  },

  /* ---------------- Detail modal ---------------- */
  async openDetail(id) {
    const idx = await DB.getProjectsIndex();
    const p = idx[id];
    if (!p) return Util.toast("Pod nicht mehr verfügbar.");
    this.currentDetailId = id;
    const [c1, c2] = Util.colorFor(p.id);
    const isMine = Auth.current && Auth.current.id === p.creatorId;
    const fav = Projects.isFavorite(id);
    const modal = document.getElementById("detailModal");
    modal.innerHTML = `
      <button class="modal__close" data-close="detailOverlay">✕</button>
      <div class="detail__thumb" style="background:linear-gradient(135deg,${c1},${c2})">${Util.esc(p.name[0]?.toUpperCase() || "?")}</div>
      <h2 class="detail__title">${Util.esc(p.name)}</h2>
      <div class="detail__by">von <b>${Util.esc(p.creatorName)}</b> ${p.multiplayer ? '· <span class="mp-badge">⬡ Multiplayer</span>' : ""}</div>
      <p class="detail__desc">${Util.esc(p.desc || "Keine Beschreibung.")}</p>
      <div class="pod-card__tags" style="margin-bottom:16px;">${p.tags.map(t => `<span class="tag-chip">#${Util.esc(t)}</span>`).join("")}</div>
      <div class="detail__stats">
        <div><b>${p.plays || 0}</b>Plays</div>
        <div><b>${p.favorites || 0}</b>Favoriten</div>
        <div><b id="detailLiveCount">…</b>Live jetzt</div>
      </div>
      <div class="detail__actions">
        <button class="btn btn--primary" id="playSoloBtn">▶ Solo spielen</button>
        ${p.multiplayer ? '<button class="btn btn--ghost" id="playMpBtn">⬡ Multiplayer</button>' : ""}
        <button class="btn btn--ghost" id="favBtn">${fav ? "★ Favorisiert" : "☆ Favorisieren"}</button>
        ${isMine ? '<button class="btn btn--ghost" id="editBtn">✎ Bearbeiten</button>' : ""}
      </div>`;
    modal.querySelector("[data-close]").addEventListener("click", () => this.toggle("detailOverlay", false));
    document.getElementById("playSoloBtn").addEventListener("click", () => { this.toggle("detailOverlay", false); this.startPlay(id, false); });
    if (p.multiplayer) document.getElementById("playMpBtn").addEventListener("click", () => { this.toggle("detailOverlay", false); this.openMpChoice(id); });
    document.getElementById("favBtn").addEventListener("click", async () => {
      const nowFav = await Projects.toggleFavorite(id);
      document.getElementById("favBtn").textContent = nowFav ? "★ Favorisiert" : "☆ Favorisieren";
    });
    if (isMine) document.getElementById("editBtn").addEventListener("click", () => { this.toggle("detailOverlay", false); this.openCreate(id); });

    Presence.countFor(id).then(n => { const el = document.getElementById("detailLiveCount"); if (el) el.textContent = n; });
    this.toggle("detailOverlay", true);
  },

  /* ---------------- Multiplayer choice ---------------- */
  openMpChoice(id) {
    const modal = document.getElementById("mpModal");
    modal.innerHTML = `
      <button class="modal__close" data-close="mpOverlay">✕</button>
      <h2>Multiplayer</h2>
      <div class="mp-choice">
        <button class="mp-choice-btn" id="hostChoice"><span><strong>Session hosten</strong><span>Erzeuge einen Code, Freunde treten bei</span></span> ⬡</button>
        <button class="mp-choice-btn" id="joinChoice"><span><strong>Session beitreten</strong><span>Mit einem Session-Code verbinden</span></span> ⌁</button>
      </div>`;
    modal.querySelector("[data-close]").addEventListener("click", () => this.toggle("mpOverlay", false));
    document.getElementById("hostChoice").addEventListener("click", () => this.startPlay(id, true, "host"));
    document.getElementById("joinChoice").addEventListener("click", () => this.showJoinForm(id));
    this.toggle("mpOverlay", true);
  },

  showJoinForm(id) {
    const modal = document.getElementById("mpModal");
    modal.innerHTML = `
      <button class="modal__close" data-close="mpOverlay">✕</button>
      <h2>Session beitreten</h2>
      <label>Session-Code
        <input id="joinCodeInput" placeholder="z.B. AB3F9K" style="text-transform:uppercase;">
      </label>
      <p class="form-error" id="joinError"></p>
      <button class="btn btn--primary" id="joinGoBtn">Beitreten</button>`;
    modal.querySelector("[data-close]").addEventListener("click", () => this.toggle("mpOverlay", false));
    document.getElementById("joinGoBtn").addEventListener("click", () => {
      const code = document.getElementById("joinCodeInput").value.trim();
      if (!code) { document.getElementById("joinError").textContent = "Bitte Code eingeben."; return; }
      this.startPlay(id, true, "join", code);
    });
  },

  /* ---------------- Play / sandbox ---------------- */
  async startPlay(id, multiplayer, mpRole, mpCode) {
    this.toggle("mpOverlay", false);
    const idx = await DB.getProjectsIndex();
    const p = idx[id];
    if (!p) return Util.toast("Pod nicht mehr verfügbar.");
    const code = await DB.getProjectCode(id);

    this.playingId = id;
    document.getElementById("playTitle").textContent = p.name;
    document.getElementById("mpStatus").textContent = "";
    Projects.bumpPlays(id);
    Projects.recordInterest(p.tags);

    const meta = { multiplayer: !!multiplayer, mpIsHost: mpRole === "host" };
    const frame = document.getElementById("playFrame");

    Multiplayer.onGameMessage = (from, data) => {
      frame.contentWindow?.postMessage({ __pv: true, type: "mp-message", from, data }, "*");
    };
    const peerCb = (peers) => {
      frame.contentWindow?.postMessage({ __pv: true, type: "mp-peers", peers }, "*");
      document.getElementById("mpStatus").textContent = `⬡ ${peers.filter(p => p.connected).length} verbunden`;
    };
    const statusCb = (msg) => { document.getElementById("mpStatus").textContent = msg; };

    document.getElementById("playLiveCount").textContent = "…";
    Presence.startHeartbeat(id, (n) => { document.getElementById("playLiveCount").textContent = n; });

    if (multiplayer && mpRole === "host") {
      try {
        const c = await Multiplayer.host(id, statusCb, peerCb);
        meta.mpCode = c;
        Util.toast(`Session-Code: ${c} — teile ihn mit Freunden!`);
      } catch (e) { Util.toast("Hosting fehlgeschlagen: " + e.message); }
    } else if (multiplayer && mpRole === "join") {
      statusCb("Verbinde …");
      Multiplayer.join(mpCode, statusCb, peerCb).catch(e => Util.toast("Beitritt fehlgeschlagen: " + e.message));
      meta.mpCode = mpCode.toUpperCase();
    }

    frame.srcdoc = Sandbox.build(code, meta);

    // relay iframe -> multiplayer network
    this._playMsgHandler = (e) => {
      if (e.source !== frame.contentWindow || !e.data || !e.data.__pv) return;
      if (e.data.type === "mp-send") Multiplayer.send(e.data.data);
    };
    window.addEventListener("message", this._playMsgHandler);

    this.toggle("detailOverlay", false);
    document.getElementById("playView").hidden = false;
  },

  exitPlay() {
    document.getElementById("playView").hidden = true;
    document.getElementById("playFrame").srcdoc = "about:blank";
    if (this._playMsgHandler) window.removeEventListener("message", this._playMsgHandler);
    Presence.stopHeartbeat(this.playingId);
    Multiplayer.reset();
    this.playingId = null;
    this.loadHome();
  },

  /* ---------------- Create / edit ---------------- */
  wireCreate() {
    const codeState = { html: "", css: "", js: "", py: "" };
    this._codeState = codeState;
    const editor = document.getElementById("codeEditor");
    let activeLang = "html";
    editor.addEventListener("input", () => { codeState[activeLang] = editor.value; });

    document.querySelectorAll(".langtab").forEach(tab => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".langtab").forEach(t => t.classList.remove("is-active"));
        tab.classList.add("is-active");
        activeLang = tab.dataset.lang;
        editor.value = codeState[activeLang] || "";
        editor.placeholder = {
          html: "<!-- HTML hier einfügen -->",
          css: "/* CSS hier einfügen */",
          js: "// JavaScript hier einfügen — window.Podverse steht zur Verfügung",
          py: "# Python hier einfügen — läuft via Pyodide im Browser"
        }[activeLang];
      });
    });

    document.getElementById("publishBtn").addEventListener("click", () => this.submitCreate());
    document.getElementById("deleteProjectBtn").addEventListener("click", async () => {
      if (!this.currentEditingId) return;
      if (!confirm("Diesen Pod wirklich löschen?")) return;
      try {
        await Projects.remove(this.currentEditingId);
        this.toggle("createOverlay", false);
        Util.toast("Pod gelöscht.");
        this.loadHome();
      } catch (e) { Util.toast(e.message); }
    });
  },

  async openCreate(id) {
    this.currentEditingId = id;
    document.getElementById("createError").textContent = "";
    document.getElementById("deleteProjectBtn").hidden = !id;
    const tagInputs = document.querySelectorAll(".tag-input");
    if (id) {
      document.getElementById("createTitle").textContent = "Pod bearbeiten";
      const idx = await DB.getProjectsIndex();
      const p = idx[id];
      document.getElementById("cName").value = p.name;
      document.getElementById("cDesc").value = p.desc;
      document.getElementById("cMultiplayer").checked = p.multiplayer;
      tagInputs.forEach((inp, i) => inp.value = p.tags[i] || "");
      const code = await DB.getProjectCode(id);
      Object.assign(this._codeState, code);
    } else {
      document.getElementById("createTitle").textContent = "Neuen Pod erstellen";
      document.getElementById("cName").value = "";
      document.getElementById("cDesc").value = "";
      document.getElementById("cMultiplayer").checked = false;
      tagInputs.forEach(inp => inp.value = "");
      Object.assign(this._codeState, { html: "", css: "", js: "", py: "" });
    }
    document.querySelectorAll(".langtab").forEach(t => t.classList.remove("is-active"));
    document.querySelector('.langtab[data-lang="html"]').classList.add("is-active");
    document.getElementById("codeEditor").value = this._codeState.html || "";
    this.toggle("createOverlay", true);
  },

  async submitCreate() {
    const err = document.getElementById("createError"); err.textContent = "";
    const name = document.getElementById("cName").value;
    const desc = document.getElementById("cDesc").value;
    const tags = [...document.querySelectorAll(".tag-input")].map(i => i.value.trim().replace(/^#/, ""));
    const multiplayer = document.getElementById("cMultiplayer").checked;
    const code = this._codeState;
    try {
      if (this.currentEditingId) {
        await Projects.update(this.currentEditingId, { name, desc, tags, multiplayer, code });
        Util.toast("Pod aktualisiert.");
      } else {
        await Projects.create({ name, desc, tags, multiplayer, code });
        Util.toast("Pod veröffentlicht!");
      }
      this.toggle("createOverlay", false);
      this.loadHome();
    } catch (e) { err.textContent = e.message; }
  }
};

document.addEventListener("DOMContentLoaded", () => UI.init());
window.addEventListener("beforeunload", () => { if (UI.playingId) Presence.leave(UI.playingId); });
