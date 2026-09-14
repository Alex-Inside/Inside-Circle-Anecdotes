/**
 * Sondage d'anecdotes INSIDE CIRCLE.
 *
 * Un Worker Cloudflare sert la page publique et expose une petite API.
 * Tout l'état de la session (anecdotes, votes, phase) vit dans un unique
 * Durable Object : un seul écrivain, donc un décompte toujours cohérent,
 * et une diffusion WebSocket vers tous les téléphones connectés.
 */

const MAX_ANECDOTES = 60;
const MAX_TEXT = 400;
const MAX_AUTHOR = 40;
const PHASES = ["lobby", "vote", "results"];

/** Repère de version : /api/state le renvoie, la page l'affiche en bas. */
const VERSION = 7;

/** Nombre d'anecdotes que chaque participant peut choisir. */
const PICKS = 3;

const DEFAULTS = {
  phase: "lobby",
  title: "Battle d'anecdotes",
  subtitle: "INSIDE CIRCLE — Événement de lancement",
  anecdotes: [],
  votes: {},
  voteEndsAt: 0,   // 0 = pas de minuterie
  updatedAt: 0,
};

const VOTE_MINUTES_DEFAULT = 5;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const clean = (value, max) => String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);

const isVoterId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(value);

/** Comparaison à durée constante, pour ne pas fuiter le token admin. */
function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** "Texte de l'anecdote | Prénom" -> {text, author}. Une ligne, une anecdote. */
function parseList(raw) {
  return String(raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const cut = line.lastIndexOf("|");
      if (cut > 0 && line.length - cut <= 42) {
        return { text: line.slice(0, cut).trim(), author: line.slice(cut + 1).trim() };
      }
      return { text: line, author: "" };
    });
}

export class Poll {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.data = { ...DEFAULTS };
    this.lastWrite = new Map();
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get("data");
      if (stored) this.data = { ...DEFAULTS, ...stored };
      for (const [voter, choice] of Object.entries(this.data.votes)) {
        if (!Array.isArray(choice)) this.data.votes[voter] = choice ? [choice] : [];
      }
    });
  }

  /** Pré-charge la liste fournie dans wrangler.toml, une seule fois. */
  async ensureSeed() {
    if (this.seedChecked) return;
    this.seedChecked = true;
    if (await this.ctx.storage.get("seeded")) return;
    const raw = this.env.SEED_ANECDOTES;
    if (!raw || !String(raw).trim()) return;
    if (this.data.anecdotes.length === 0) {
      this.data.anecdotes = parseList(raw)
        .slice(0, MAX_ANECDOTES)
        .map((item) => ({
          id: crypto.randomUUID().slice(0, 8),
          text: clean(item.text, MAX_TEXT),
          author: clean(item.author, MAX_AUTHOR),
        }))
        .filter((item) => item.text);
    }
    await this.ctx.storage.put("seeded", true);
    await this.save();
  }

  /** Réveille le Durable Object à l'échéance, pour diffuser la clôture. */
  async scheduleAlarm() {
    if (this.data.voteEndsAt > Date.now()) {
      await this.ctx.storage.setAlarm(this.data.voteEndsAt);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  async alarm() {
    this.broadcast();
  }

  async save() {
    this.data.updatedAt = Date.now();
    await this.ctx.storage.put("data", this.data);
    this.broadcast();
  }

  tally() {
    const counts = new Map(this.data.anecdotes.map((a) => [a.id, 0]));
    for (const choices of Object.values(this.data.votes)) {
      for (const choice of choices) {
        if (counts.has(choice)) counts.set(choice, counts.get(choice) + 1);
      }
    }
    return this.data.anecdotes
      .map((a, index) => ({ id: a.id, votes: counts.get(a.id) || 0, order: index }))
      .sort((x, y) => (y.votes !== x.votes ? y.votes - x.votes : x.order - y.order));
  }

  /** Millisecondes restantes, ou null si aucune minuterie n'est armée. */
  remainingMs() {
    if (!this.data.voteEndsAt) return null;
    return Math.max(0, this.data.voteEndsAt - Date.now());
  }

  /** Le scrutin est-il fermé par la minuterie ? */
  isClosed() {
    return Boolean(this.data.voteEndsAt) && Date.now() >= this.data.voteEndsAt;
  }

  /** Ce que tout le monde a le droit de voir. Les scores restent cachés hors révélation. */
  publicState() {
    return {
      phase: this.data.phase,
      title: this.data.title,
      subtitle: this.data.subtitle,
      anecdotes: this.data.anecdotes.map((a) => ({ id: a.id, text: a.text, author: a.author })),
      voters: Object.keys(this.data.votes).length,
      picks: PICKS,
      remainingMs: this.remainingMs(),
      closed: this.data.phase === "vote" && this.isClosed(),
      results: this.data.phase === "results" ? this.tally() : null,
      updatedAt: this.data.updatedAt,
    };
  }

  broadcast() {
    const payload = JSON.stringify({ type: "state", state: this.publicState() });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch (err) {
        // Socket morte : le runtime la nettoiera, rien à faire ici.
      }
    }
  }

  isAdmin(request) {
    const expected = this.env.ADMIN_TOKEN;
    if (!expected) return false;
    const header = request.headers.get("x-admin-token") || "";
    return sameSecret(header, expected);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    await this.ensureSeed();

    if (path === "/api/ws") {
      if (request.headers.get("upgrade") !== "websocket") {
        return new Response("Attendu : une connexion WebSocket.", { status: 426 });
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].send(JSON.stringify({ type: "state", state: this.publicState() }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (path === "/api/state" && request.method === "GET") {
      const voter = url.searchParams.get("voter");
      return json({
        state: this.publicState(),
        myChoices: isVoterId(voter) ? this.data.votes[voter] || [] : [],
        adminConfigured: Boolean(this.env.ADMIN_TOKEN),
        version: VERSION,
      });
    }

    if (path === "/api/vote" && request.method === "POST") {
      if (this.data.phase !== "vote") {
        return json({ error: "closed", message: "Le vote n'est pas ouvert." }, 409);
      }
      if (this.isClosed()) {
        return json({ error: "time_up", message: "Le temps est écoulé, le vote est clos." }, 409);
      }
      const body = await request.json().catch(() => null);
      if (!body || !isVoterId(body.voter)) {
        return json({ error: "bad_request", message: "Identifiant de votant invalide." }, 400);
      }
      // On accepte une liste de choix ; l'ancien format à choix unique reste valide.
      const asked = Array.isArray(body.choices) ? body.choices : (body.choice ? [body.choice] : []);
      const choices = [];
      for (const id of asked) {
        if (choices.indexOf(id) === -1) choices.push(id);
      }
      if (choices.length === 0 || choices.length > PICKS) {
        return json(
          { error: "bad_choices", message: `Choisis entre 1 et ${PICKS} anecdotes.` },
          400
        );
      }
      const known = new Set(this.data.anecdotes.map((a) => a.id));
      if (!choices.every((id) => known.has(id))) {
        return json({ error: "unknown_choice", message: "Une des anecdotes n'est plus en lice." }, 400);
      }
      const now = Date.now();
      if (now - (this.lastWrite.get(body.voter) || 0) < 700) {
        return json({ error: "slow_down", message: "Doucement, un vote à la fois." }, 429);
      }
      this.lastWrite.set(body.voter, now);
      this.data.votes[body.voter] = choices;
      await this.save();
      return json({ ok: true, myChoices: choices, state: this.publicState() });
    }

    if (path.startsWith("/api/admin/")) {
      if (!this.env.ADMIN_TOKEN) {
        return json(
          { error: "no_admin", message: "Aucun code régie configuré. Voir README.md (wrangler secret put ADMIN_TOKEN)." },
          503
        );
      }
      if (!this.isAdmin(request)) {
        return json({ error: "forbidden", message: "Code régie incorrect." }, 403);
      }

      if (path === "/api/admin/check") {
        return json({ ok: true, state: this.publicState(), tally: this.tally() });
      }

      if (path === "/api/admin/phase" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (!PHASES.includes(body.phase)) {
          return json({ error: "bad_phase", message: "Phase inconnue." }, 400);
        }
        if (body.phase === "vote" && this.data.anecdotes.length === 0) {
          return json({ error: "no_anecdotes", message: "Enregistre d'abord la liste des anecdotes." }, 400);
        }
        this.data.phase = body.phase;
        if (body.phase === "vote") {
          // Ouvrir le vote arme la minuterie ; 0 minute = pas de limite.
          const minutes = body.minutes === undefined ? VOTE_MINUTES_DEFAULT : Number(body.minutes);
          const safe = Number.isFinite(minutes) ? Math.max(0, Math.min(60, minutes)) : VOTE_MINUTES_DEFAULT;
          this.data.voteEndsAt = safe > 0 ? Date.now() + safe * 60000 : 0;
          await this.scheduleAlarm();
        } else {
          this.data.voteEndsAt = 0;
        }
        await this.save();
        return json({ ok: true, state: this.publicState() });
      }

      if (path === "/api/admin/anecdotes" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (typeof body.raw === "string") body.items = parseList(body.raw);
        if (!Array.isArray(body.items)) {
          return json({ error: "bad_request", message: "Liste d'anecdotes attendue." }, 400);
        }
        if (body.items.length > MAX_ANECDOTES) {
          return json(
            { error: "too_many", message: `Maximum ${MAX_ANECDOTES} anecdotes (reçu ${body.items.length}).` },
            400
          );
        }
        const previous = new Map(this.data.anecdotes.map((a) => [a.text, a.id]));
        const used = new Set();
        const items = [];
        for (const raw of body.items) {
          const text = clean(raw && raw.text, MAX_TEXT);
          if (!text) continue;
          let id = previous.get(text);
          if (!id || used.has(id)) id = crypto.randomUUID().slice(0, 8);
          used.add(id);
          items.push({ id, text, author: clean(raw && raw.author, MAX_AUTHOR) });
        }
        this.data.anecdotes = items;
        // Un vote pour une anecdote disparue ne compte plus : on le retire.
        const alive = new Set(items.map((a) => a.id));
        for (const [voter, choices] of Object.entries(this.data.votes)) {
          const kept = choices.filter((id) => alive.has(id));
          if (kept.length) this.data.votes[voter] = kept;
          else delete this.data.votes[voter];
        }
        await this.save();
        return json({ ok: true, state: this.publicState() });
      }

      if (path === "/api/admin/timer" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (body.action === "stop") {
          this.data.voteEndsAt = Date.now();          // clôture immédiate
        } else if (body.action === "clear") {
          this.data.voteEndsAt = 0;                   // vote sans limite de temps
        } else {
          const minutes = Number(body.minutes);
          if (!Number.isFinite(minutes) || minutes === 0) {
            return json({ error: "bad_request", message: "Durée invalide." }, 400);
          }
          const base = this.data.voteEndsAt && !this.isClosed() ? this.data.voteEndsAt : Date.now();
          this.data.voteEndsAt = Math.max(Date.now(), base + minutes * 60000);
        }
        await this.scheduleAlarm();
        await this.save();
        return json({ ok: true, state: this.publicState() });
      }

      if (path === "/api/admin/meta" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (typeof body.title === "string") this.data.title = clean(body.title, 70) || DEFAULTS.title;
        if (typeof body.subtitle === "string") this.data.subtitle = clean(body.subtitle, 90);
        await this.save();
        return json({ ok: true, state: this.publicState() });
      }

      if (path === "/api/admin/reset" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (body.scope === "all") {
          this.data.anecdotes = [];
          this.data.votes = {};
          this.data.phase = "lobby";
          this.data.voteEndsAt = 0;
        } else {
          this.data.votes = {};
        }
        await this.save();
        return json({ ok: true, state: this.publicState() });
      }

      return json({ error: "not_found", message: "Route régie inconnue." }, 404);
    }

    return json({ error: "not_found", message: "Route inconnue." }, 404);
  }

  webSocketMessage(socket, message) {
    if (message === "ping") socket.send("pong");
  }

  webSocketClose(socket) {
    try {
      socket.close();
    } catch (err) {
      // déjà fermée
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      const id = env.POLL.idFromName(env.SESSION_NAME || "default");
      return env.POLL.get(id).fetch(request);
    }

    let asset = await env.ASSETS.fetch(request);
    if (asset.status === 404) {
      asset = await env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
    }
    const type = asset.headers.get("content-type") || "";
    if (type.includes("text/html")) {
      const fresh = new Response(asset.body, asset);
      fresh.headers.set("cache-control", "no-store, must-revalidate");
      return fresh;
    }
    return asset;
  },
};
