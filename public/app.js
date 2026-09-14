/* Sondage d'anecdotes INSIDE CIRCLE — application de la page publique. */
(function () {
  "use strict";

  var PHASES = ["lobby", "vote", "results"];
  var el = function (id) { return document.getElementById(id); };

  var state = null;        // dernier état reçu du serveur
  var myChoices = [];      // anecdotes déjà votées depuis ce téléphone
  var selection = null;    // sélection en cours (liste), pas encore validée
  var adminToken = null;
  var tally = null;        // décompte réservé à la régie
  var socket = null;
  var pollTimer = null;
  var toastTimer = null;
  var bulkDirty = false;
  var qrDrawn = false;
  var deadline = null;     // échéance locale, recalculée à chaque état reçu
  var tickTimer = null;

  /* ---------- stockage local ---------- */
  function ls(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  var voterId = ls("ic-voter", null);
  if (!voterId || !/^[A-Za-z0-9_-]{6,64}$/.test(voterId)) {
    voterId = "v" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    lsSet("ic-voter", voterId);
  }

  /* ---------- utilitaires ---------- */
  function toast(msg) {
    var t = el("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3000);
  }
  function plural(n, one, many) { return n + " " + (n > 1 ? many : one); }
  function mmss(ms) {
    var total = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(total / 60) + ":" + (total % 60 < 10 ? "0" : "") + (total % 60);
  }
  /** Temps restant, compté localement depuis la dernière valeur du serveur. */
  function remaining() {
    if (deadline === null) return null;
    return Math.max(0, deadline - Date.now());
  }
  function timeUp() {
    var r = remaining();
    return r !== null && r === 0;
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function sameSet(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    return a.every(function (id) { return b.indexOf(id) >= 0; });
  }
  function anecdoteById(id) {
    if (!state) return null;
    return state.anecdotes.filter(function (a) { return a.id === id; })[0] || null;
  }

  function api(path, options) {
    var opts = options || {};
    var headers = { "content-type": "application/json" };
    if (opts.admin && adminToken) headers["x-admin-token"] = adminToken;
    return fetch(path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: "no-store"
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.message || "Erreur réseau");
          err.status = res.status;
          err.code = data.error;
          throw err;
        }
        return data;
      });
    });
  }

  /* ---------- connexion ---------- */
  function setLive(on, label) {
    el("dot").className = "dot" + (on ? " on" : "");
    el("liveLabel").textContent = label;
  }

  function applyState(next) {
    state = next;
    // Le serveur envoie une durée, jamais une heure absolue : les horloges des
    // téléphones ne sont pas fiables.
    deadline = (next && typeof next.remainingMs === "number") ? Date.now() + next.remainingMs : null;
    render();
    startTicking();
  }

  function startTicking() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (deadline === null || !state || state.phase !== "vote") return;
    tickTimer = setInterval(function () {
      var node = el("clock");
      var left = remaining();
      if (node && left !== null) {
        node.textContent = mmss(left);
        node.classList.toggle("urgent", left <= 60000);
      }
      var big = el("clockBig");
      if (big && left !== null) {
        big.textContent = mmss(left);
        big.classList.toggle("urgent", left <= 60000);
      }
      if (left === 0) {
        clearInterval(tickTimer);
        tickTimer = null;
        render();
        loadState();   // le serveur confirme la clôture
      }
    }, 1000);
  }

  function loadState() {
    return api("/api/state?voter=" + encodeURIComponent(voterId)).then(function (data) {
      myChoices = data.myChoices || [];
      if (selection === null) selection = myChoices.slice();
      el("footNote").textContent = data.adminConfigured ? "" : "Code régie non configuré sur ce déploiement.";
      applyState(data.state);
      setLive(true, "En direct");
    }).catch(function () {
      setLive(false, "Hors ligne");
    });
  }

  function openSocket() {
    if (!("WebSocket" in window)) return startPolling();
    try {
      socket = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/ws");
    } catch (e) {
      return startPolling();
    }
    socket.addEventListener("open", function () {
      setLive(true, "En direct");
      stopPolling();
    });
    socket.addEventListener("message", function (ev) {
      if (ev.data === "pong") return;
      try {
        var msg = JSON.parse(ev.data);
        if (msg.type === "state") {
          applyState(msg.state);
          if (adminToken) refreshPeek();
        }
      } catch (e) { /* message ignoré */ }
    });
    socket.addEventListener("close", function () {
      setLive(false, "Reconnexion…");
      socket = null;
      startPolling();
      setTimeout(openSocket, 4000);
    });
    socket.addEventListener("error", function () { try { socket.close(); } catch (e) {} });
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(loadState, 5000);
  }
  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  /* ---------- rendu ---------- */
  function render() {
    if (!state) return;

    el("title").textContent = state.title;
    el("subtitle").textContent = state.subtitle || "";
    el("subtitle").hidden = !state.subtitle;
    document.title = state.title + " — INSIDE CIRCLE";

    var idx = Math.max(0, PHASES.indexOf(state.phase));
    Array.prototype.forEach.call(document.querySelectorAll(".stepx"), function (node) {
      var i = PHASES.indexOf(node.getAttribute("data-step"));
      node.setAttribute("data-state", i === idx ? "active" : (i < idx ? "done" : "todo"));
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-phase]"), function (b) {
      b.classList.toggle("on", b.getAttribute("data-phase") === state.phase);
    });
    var next = el("revealNext");
    if (next) {
      var steps = ["Révéler la 3e place", "Révéler la 2e place", "Révéler la 1re place", "Podium complet"];
      next.textContent = steps[Math.min(3, state.reveal || 0)];
      next.disabled = state.phase !== "results" || (state.reveal || 0) >= 3;
    }

    if (document.activeElement !== el("titleInput")) el("titleInput").value = state.title;
    if (document.activeElement !== el("subtitleInput")) el("subtitleInput").value = state.subtitle || "";
    if (!bulkDirty && document.activeElement !== el("bulk")) el("bulk").value = serializeAnecdotes();
    el("bulkHint").textContent = state.anecdotes.length
      ? plural(state.anecdotes.length, "anecdote en lice", "anecdotes en lice")
      : "Aucune anecdote enregistrée";

    if (state.phase === "lobby") renderLobby();
    else if (state.phase === "vote") renderVote();
    else renderResults();

    if (!el("project").hidden) renderProjection();
  }

  function renderLobby() {
    el("stageTitle").textContent = "Le vote ouvre dans un instant";
    el("stageMeter").textContent = state.anecdotes.length
      ? plural(state.anecdotes.length, "anecdote", "anecdotes")
      : "En préparation";

    var body = el("stageBody");
    body.innerHTML = "";
    var hold = document.createElement("div");
    hold.className = "hold";
    hold.innerHTML = "<strong>Tu es bien connecté</strong><span></span>";
    hold.querySelector("span").textContent = state.anecdotes.length
      ? "Garde cette page ouverte : les anecdotes apparaîtront ici dès l'ouverture du vote."
      : "L'animateur prépare les anecdotes. Garde cette page ouverte.";
    body.appendChild(hold);
  }

  function renderVote() {
    var picks = state.picks || 1;
    var closed = state.closed || timeUp();
    if (selection === null) selection = myChoices.slice();

    el("stageTitle").textContent = closed
      ? "Vote clos"
      : (picks > 1 ? "Choisis tes " + picks + " anecdotes préférées" : "Choisis ton anecdote préférée");

    var left = remaining();
    el("stageMeter").innerHTML = "";
    if (left !== null) {
      var clock = document.createElement("span");
      clock.id = "clock";
      clock.className = "clock" + (left <= 60000 ? " urgent" : "");
      clock.textContent = mmss(left);
      el("stageMeter").appendChild(clock);
    }
    el("stageMeter").appendChild(document.createTextNode(" " + plural(state.voters, "votant", "votants")));

    var body = el("stageBody");
    body.innerHTML = "";

    if (!state.anecdotes.length) {
      var hold = document.createElement("div");
      hold.className = "hold";
      hold.innerHTML = "<strong>Bientôt</strong><span>Les anecdotes arrivent.</span>";
      body.appendChild(hold);
      return;
    }

    if (closed) {
      var over = document.createElement("div");
      over.className = "note";
      over.textContent = myChoices.length
        ? "Le temps est écoulé. Ton vote est bien enregistré — le Top 3 arrive."
        : "Le temps est écoulé, le vote est clos. Le Top 3 arrive.";
      body.appendChild(over);
    }

    if (myChoices.length) {
      var done = document.createElement("div");
      done.className = "voted";
      done.innerHTML = '<span class="lead">Vote enregistré</span><ul class="picks"></ul>' +
        (closed ? "" : '<span class="muted">Tu peux encore changer d\'avis tant que le vote est ouvert.</span>');
      var ul = done.querySelector(".picks");
      myChoices.forEach(function (id) {
        var a = anecdoteById(id);
        var li = document.createElement("li");
        li.textContent = a ? a.text : "Anecdote retirée";
        ul.appendChild(li);
      });
      body.appendChild(done);
    } else if (!closed) {
      var note = document.createElement("div");
      note.className = "note";
      note.textContent = picks > 1
        ? "Choisis jusqu'à " + picks + " anecdotes : la plus drôle, la plus intéressante, la plus originale. Les scores restent cachés jusqu'à la révélation du Top 3."
        : "Une seule anecdote à choisir. Les scores restent cachés jusqu'à la révélation du Top 3.";
      body.appendChild(note);
    }

    var list = document.createElement("div");
    list.className = "options";
    state.anecdotes.forEach(function (a, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "option";
      var on = selection.indexOf(a.id) >= 0;
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.innerHTML = '<span class="ohead"><span class="num">' + pad2(i + 1) +
        '</span><span class="tick" aria-hidden="true">✓</span></span><span class="txt"></span>';
      b.querySelector(".txt").textContent = a.text;
      b.disabled = closed;
      b.addEventListener("click", function () {
        if (closed) return;
        var at = selection.indexOf(a.id);
        if (at >= 0) {
          selection.splice(at, 1);
        } else if (selection.length >= picks) {
          toast(picks + " anecdotes maximum. Désélectionne-en une d'abord.");
          return;
        } else {
          selection.push(a.id);
        }
        renderVote();
      });
      list.appendChild(b);
    });
    body.appendChild(list);

    var bar = document.createElement("div");
    bar.className = "cta-bar";
    var submit = document.createElement("button");
    submit.type = "button";
    submit.className = "btn big";
    var unchanged = sameSet(selection, myChoices);
    submit.textContent = closed
      ? "Vote clos"
      : (myChoices.length ? "Changer mon vote" : (selection.length > 1 ? "Valider mes " + selection.length + " choix" : "Valider mon vote"));
    submit.disabled = closed || selection.length === 0 || unchanged;
    submit.addEventListener("click", function () {
      submit.disabled = true;
      api("/api/vote", { method: "POST", body: { voter: voterId, choices: selection.slice() } })
        .then(function (data) {
          myChoices = data.myChoices || [];
          selection = myChoices.slice();
          applyState(data.state);
          toast("Vote enregistré. Merci !");
        })
        .catch(function (err) {
          submit.disabled = false;
          toast(err.message || "Le vote n'a pas pu être enregistré.");
        });
    });
    bar.appendChild(submit);
    var hint = document.createElement("span");
    hint.className = "muted";
    hint.textContent = closed
      ? "Merci !"
      : selection.length + " / " + picks + (selection.length > 1 ? " sélectionnées" : " sélectionnée");
    bar.appendChild(hint);
    body.appendChild(bar);
  }

  /** Les places révélées, par rang. Le public ne reçoit aucun décompte. */
  function podiumByRank() {
    var byRank = {};
    (state.results || []).forEach(function (r) {
      byRank[r.rank] = anecdoteById(r.id);
    });
    return byRank;
  }

  function buildPodium(byRank) {
    var podium = document.createElement("div");
    podium.className = "podium";
    [2, 1, 3].forEach(function (rank) {          // ordre visuel du podium
      var a = byRank[rank];
      var p = document.createElement("div");
      p.className = "plinth" + (a ? "" : " masked");
      p.setAttribute("data-rank", String(rank));
      p.innerHTML = (rank === 1 && a ? '<div class="crown">Anecdote préférée</div>' : "") +
        '<div class="pos">' + rank + '</div>' +
        (a ? '<div class="txt"></div>' : '<div class="qmark" aria-label="pas encore révélé">?</div>');
      if (a) p.querySelector(".txt").textContent = a.text;
      podium.appendChild(p);
    });
    return podium;
  }

  function renderResults() {
    var byRank = podiumByRank();
    var shown = Object.keys(byRank).length;

    el("stageTitle").textContent = "Le Top 3";
    el("stageMeter").textContent = plural(state.voters, "votant", "votants");

    var body = el("stageBody");
    body.innerHTML = "";

    if (!state.anecdotes.length || state.voters === 0) {
      var hold = document.createElement("div");
      hold.className = "hold";
      hold.innerHTML = "<strong>Pas encore de votes</strong><span>Le classement s'affichera ici.</span>";
      body.appendChild(hold);
      return;
    }

    if (shown === 0) {
      var wait = document.createElement("div");
      wait.className = "note";
      wait.textContent = "Roulement de tambour… le podium se dévoile dans un instant.";
      body.appendChild(wait);
    }
    body.appendChild(buildPodium(byRank));
  }

  /* ---------- QR code ---------- */
  function loadQrLib() {
    if (window.qrcode) return Promise.resolve(true);
    var sources = ["/vendor/qrcode.js", "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js"];
    return new Promise(function (resolve) {
      (function next(i) {
        if (i >= sources.length) return resolve(false);
        var s = document.createElement("script");
        s.src = sources[i];
        s.onload = function () { resolve(Boolean(window.qrcode)); };
        s.onerror = function () { next(i + 1); };
        document.head.appendChild(s);
      })(0);
    });
  }

  function drawQr(node, url) {
    if (!window.qrcode) { node.innerHTML = ""; return false; }
    try {
      var q = window.qrcode(0, "M");
      q.addData(url);
      q.make();
      node.innerHTML = q.createSvgTag({ cellSize: 8, margin: 1, scalable: true });
      return true;
    } catch (e) {
      node.innerHTML = "";
      return false;
    }
  }

  /* ---------- écran de projection ---------- */
  function renderProjection() {
    var box = el("projectBody");
    var url = location.origin + "/";

    if (state && state.phase === "results") {
      box.innerHTML = '<div class="kicker">Inside Circle</div><div class="huge"></div>';
      box.querySelector(".huge").textContent = "Le Top 3";
      box.appendChild(buildPodium(podiumByRank()));
      var t = document.createElement("div");
      t.className = "tally";
      t.textContent = plural(state.voters, "votant", "votants");
      box.appendChild(t);
      return;
    }

    var left = remaining();
    box.innerHTML =
      '<div class="kicker">Inside Circle</div>' +
      '<div class="huge">' + (state && state.closed ? "Vote clos" : "Scanne et vote") + '</div>' +
      (left === null ? "" : '<div class="clock-big" id="clockBig">' + mmss(left) + '</div>') +
      '<div class="qr" id="qrBox"></div>' +
      '<div class="url"></div>' +
      '<div class="tally"></div>';
    box.querySelector(".url").textContent = url;
    box.querySelector(".tally").textContent = state ? plural(state.voters, "vote reçu", "votes reçus") : "";

    var ok = drawQr(el("qrBox"), url);
    if (!ok) {
      el("qrBox").innerHTML = '<span style="color:#06213A;font-size:14px;display:block;padding:20px">' +
        'QR indisponible hors ligne — affiche le lien ci-dessous.</span>';
      if (!qrDrawn) {
        qrDrawn = true;
        loadQrLib().then(function (loaded) { if (loaded) renderProjection(); });
      }
    }
  }

  function openProjection() {
    el("project").hidden = false;
    renderProjection();
    el("closeProject").focus();
  }
  function closeProjection() { el("project").hidden = true; }

  /* ---------- régie ---------- */
  function serializeAnecdotes() {
    if (!state) return "";
    return state.anecdotes.map(function (a) {
      return a.text + (a.author ? " | " + a.author : "");
    }).join("\n");
  }

  function parseBulk(raw) {
    return raw.split("\n").map(function (line) { return line.trim(); })
      .filter(function (line) { return line.length > 0; })
      .map(function (line) {
        var cut = line.lastIndexOf("|");
        if (cut > 0 && line.length - cut <= 42) {
          return { text: line.slice(0, cut).trim(), author: line.slice(cut + 1).trim() };
        }
        return { text: line, author: "" };
      });
  }

  function enableRegie(token) {
    adminToken = token;
    lsSet("ic-admin", token);
    el("regie").hidden = false;
    refreshPeek();
  }

  function tryAdmin(token) {
    var previous = adminToken;
    adminToken = token;
    return api("/api/admin/check", { admin: true }).then(function (data) {
      tally = data.tally;
      enableRegie(token);
      applyState(data.state);
      toast("Régie déverrouillée.");
      return true;
    }).catch(function (err) {
      adminToken = previous;
      try { localStorage.removeItem("ic-admin"); } catch (e) {}
      toast(err.message || "Code régie incorrect.");
      return false;
    });
  }

  function refreshPeek() {
    if (!adminToken) return;
    api("/api/admin/check", { admin: true }).then(function (data) {
      tally = data.tally;
      renderPeek();
    }).catch(function () { /* la régie reste affichée */ });
  }

  function renderPeek() {
    var box = el("peek");
    box.innerHTML = "";
    if (!tally || !tally.length || !state) {
      box.innerHTML = '<span class="muted">Aucun vote pour l\'instant.</span>';
      return;
    }
    var max = tally[0].votes || 1;
    tally.forEach(function (r) {
      var a = anecdoteById(r.id);
      var row = document.createElement("div");
      row.className = "prow";
      row.innerHTML = '<span class="lab"></span><span class="n"></span><span class="bar"><i></i></span>';
      row.querySelector(".lab").textContent = a ? a.text : "—";
      row.querySelector(".n").textContent = r.votes;
      row.querySelector(".bar > i").style.width = Math.round((r.votes / max) * 100) + "%";
      box.appendChild(row);
    });
  }

  function adminPost(path, body, okMessage) {
    return api(path, { method: "POST", body: body, admin: true })
      .then(function (data) {
        applyState(data.state);
        refreshPeek();
        if (okMessage) toast(okMessage);
      })
      .catch(function (err) { toast(err.message || "Action refusée."); });
  }

  /* ---------- branchements ---------- */
  Array.prototype.forEach.call(document.querySelectorAll("[data-phase]"), function (b) {
    b.addEventListener("click", function () {
      var phase = b.getAttribute("data-phase");
      var payload = { phase: phase };
      if (phase === "vote") payload.minutes = Number(el("minutes").value);
      adminPost("/api/admin/phase", payload);
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll("[data-reveal]"), function (b) {
    b.addEventListener("click", function () {
      var action = b.getAttribute("data-reveal");
      adminPost("/api/admin/reveal", action === "reset" ? { action: "reset" } : {});
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll("[data-timer]"), function (b) {
    b.addEventListener("click", function () {
      var v = b.getAttribute("data-timer");
      if (v === "stop") {
        if (!window.confirm("Clore le vote maintenant ?")) return;
        adminPost("/api/admin/timer", { action: "stop" }, "Vote clos.");
      } else {
        adminPost("/api/admin/timer", { minutes: Number(v) }, "Temps ajusté.");
      }
    });
  });

  el("bulk").addEventListener("input", function () { bulkDirty = true; });

  el("saveBulk").addEventListener("click", function () {
    var items = parseBulk(el("bulk").value);
    if (!items.length && state && state.anecdotes.length &&
        !window.confirm("La liste est vide : supprimer toutes les anecdotes ?")) return;
    if (state && state.voters > 0 &&
        !window.confirm("Des votes sont déjà enregistrés. Modifier la liste peut fausser le classement. Continuer ?")) return;
    adminPost("/api/admin/anecdotes", { items: items },
      items.length ? plural(items.length, "anecdote enregistrée", "anecdotes enregistrées") : "Liste vidée.")
      .then(function () { bulkDirty = false; });
  });

  var metaTimer = null;
  function pushMeta() {
    clearTimeout(metaTimer);
    metaTimer = setTimeout(function () {
      adminPost("/api/admin/meta", { title: el("titleInput").value, subtitle: el("subtitleInput").value });
    }, 700);
  }
  el("titleInput").addEventListener("input", pushMeta);
  el("subtitleInput").addEventListener("input", pushMeta);

  el("resetVotes").addEventListener("click", function () {
    if (!window.confirm("Effacer tous les votes ? Les anecdotes sont conservées.")) return;
    myChoices = [];
    selection = null;
    adminPost("/api/admin/reset", { scope: "votes" }, "Votes effacés.");
  });

  el("resetAll").addEventListener("click", function () {
    if (!window.confirm("Tout effacer : anecdotes et votes. Cette action est définitive.")) return;
    myChoices = [];
    selection = null;
    adminPost("/api/admin/reset", { scope: "all" }, "Session remise à zéro.");
  });

  el("projectBtn").addEventListener("click", openProjection);
  el("closeProject").addEventListener("click", closeProjection);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !el("project").hidden) closeProjection();
  });

  el("regieBtn").addEventListener("click", function () {
    var code = window.prompt("Code régie :", "");
    if (code) tryAdmin(code.trim());
  });

  /* ---------- logo officiel, s'il a été déposé dans public/ ---------- */
  function useOfficialLogo() {
    var img = el("brandLogo");
    var candidates = ["/logo.svg", "/logo.png", "/logo.webp", "/logo.jpg", "/logo.jpeg",
                      "/logo.PNG", "/logo.SVG", "/logo.JPG"];
    var i = 0;
    img.addEventListener("load", function () {
      img.hidden = false;
      // Un SVG n'obéit pas à la propriété « hidden » : on passe par le style.
      var ring = document.querySelector(".ring");
      if (ring) ring.style.display = "none";
      el("wordmark").hidden = true;   // le fichier officiel porte déjà le nom
    });
    img.addEventListener("error", function () {
      i += 1;
      if (i < candidates.length) img.src = candidates[i];
    });
    img.src = candidates[0];
  }

  /* ---------- démarrage ---------- */
  (function boot() {
    var params = new URLSearchParams(location.search);
    var fromUrl = params.get("admin");
    var stored = ls("ic-admin", null);

    useOfficialLogo();

    loadState().then(function () {
      openSocket();
      loadQrLib();
      if (fromUrl) {
        tryAdmin(fromUrl.trim()).then(function () {
          params.delete("admin");
          var rest = params.toString();
          history.replaceState({}, "", location.pathname + (rest ? "?" + rest : ""));
        });
      } else if (stored) {
        tryAdmin(stored);
      }
    });
  })();
})();
