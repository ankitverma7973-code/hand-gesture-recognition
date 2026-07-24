/**
 * script.js
 * ---------
 * Client-side controller for GestureLab.
 *   - Starts/stops the server-side webcam pipeline
 *   - Points the <img> feed at /video_feed while active
 *   - Polls /api/stats and updates the info card, dashboard and history
 *   - Handles dark/light theme toggle (persisted in localStorage)
 *   - Handles reveal-on-scroll animation and mobile nav
 */

(function () {
  "use strict";

  const els = {
    startBtn: document.getElementById("startBtn"),
    stopBtn: document.getElementById("stopBtn"),
    videoStream: document.getElementById("videoStream"),
    videoPlaceholder: document.getElementById("videoPlaceholder"),
    videoLoader: document.getElementById("videoLoader"),
    recBadge: document.getElementById("recBadge"),
    statusPill: document.getElementById("statusPill"),
    errorBanner: document.getElementById("errorBanner"),
    errorText: document.getElementById("errorText"),

    gestureName: document.getElementById("gestureName"),
    confidenceValue: document.getElementById("confidenceValue"),
    confidenceFill: document.getElementById("confidenceFill"),
    detectionStatus: document.getElementById("detectionStatus"),
    handCount: document.getElementById("handCount"),
    fpsValue: document.getElementById("fpsValue"),
    landmarkCount: document.getElementById("landmarkCount"),
    comboBanner: document.getElementById("comboBanner"),
    comboText: document.getElementById("comboText"),
    handChips: document.getElementById("handChips"),

    statFrames: document.getElementById("statFrames"),
    statGestures: document.getElementById("statGestures"),
    statCurrent: document.getElementById("statCurrent"),
    statAccuracy: document.getElementById("statAccuracy"),
    historyList: document.getElementById("historyList"),

    themeToggle: document.getElementById("themeToggle"),
    themeIcon: document.getElementById("themeIcon"),
    navToggle: document.getElementById("navToggle"),
    navLinks: document.querySelector(".nav-links"),
  };

  let pollTimer = null;
  let cameraActive = false;
  let latestStatsData = null;
  let renderedHistoryKey = "";

  // -------------------------------------------------------------------
  // Camera controls
  // -------------------------------------------------------------------
  async function startCamera() {
    setBusy(true);
    hideError();
    els.videoLoader.style.display = "flex";
    els.videoPlaceholder.style.display = "none";

    try {
      const res = await fetch("/api/camera/start", { method: "POST" });
      const data = await res.json();

      if (!data.success) {
        showError(data.error || "Could not start the camera.");
        resetVideoUI();
        setBusy(false);
        return;
      }

      // Cache-bust so the browser opens a fresh MJPEG stream.
      els.videoStream.src = "/video_feed?t=" + Date.now();
      els.videoStream.onload = () => {}; // MJPEG keeps "loading"; loader is hidden on first frame via timer below
      setTimeout(() => { els.videoLoader.style.display = "none"; }, 900);

      cameraActive = true;
      els.startBtn.disabled = true;
      els.stopBtn.disabled = false;
      els.recBadge.style.display = "inline-flex";
      setStatusPill("live", "Detecting");
      startPolling();
    } catch (err) {
      showError("Network error while contacting the server.");
      resetVideoUI();
    }
    setBusy(false);
  }

  async function stopCamera() {
    setBusy(true);
    try {
      await fetch("/api/camera/stop", { method: "POST" });
    } catch (err) {
      /* ignore — we reset the UI regardless */
    }
    cameraActive = false;
    lastAnnouncedSignature = null;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    stopPolling();
    resetVideoUI();
    setStatusPill("idle", "Idle");
    resetInfoCard();
    setBusy(false);
  }

  function resetVideoUI() {
    els.videoStream.removeAttribute("src");
    els.videoLoader.style.display = "none";
    els.videoPlaceholder.style.display = "flex";
    els.recBadge.style.display = "none";
    els.startBtn.disabled = false;
    els.stopBtn.disabled = true;
  }

  function setBusy(isBusy) {
    els.startBtn.disabled = isBusy || cameraActive;
    els.stopBtn.disabled = isBusy || !cameraActive;
  }

  function setStatusPill(mode, label) {
    els.statusPill.classList.toggle("live", mode === "live");
    els.statusPill.querySelector("span").textContent = label;
  }

  function showError(message) {
    els.errorText.textContent = message;
    els.errorBanner.hidden = false;
  }
  function hideError() {
    els.errorBanner.hidden = true;
  }

  function resetInfoCard() {
    els.gestureName.textContent = "No Hand Detected";
    els.confidenceValue.textContent = "0%";
    els.confidenceFill.style.width = "0%";
    els.detectionStatus.textContent = "Idle";
    els.handCount.textContent = "0 / 2";
    els.fpsValue.textContent = "0";
    els.landmarkCount.textContent = "0 / 21";
    els.comboBanner.hidden = true;
    els.handChips.innerHTML = "";
  }

  // -------------------------------------------------------------------
  // Stats polling
  // -------------------------------------------------------------------
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(fetchStats, 650);
    fetchStats();
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  async function fetchStats() {
    try {
      const res = await fetch("/api/stats");
      const data = await res.json();
      renderStats(data);
      handleGestureAction(data);
      announceGestureIfNeeded(data);
      checkGestureBadges(data);
    } catch (err) {
      /* transient network hiccup — skip this tick */
    }
  }

  function renderStats(data) {
    latestStatsData = data;
    if (data.error && data.active === false && cameraActive) {
      showError(data.error);
      stopCamera();
      return;
    }

    const hands = data.hands || [];
    const handFound = hands.length > 0;

    els.gestureName.textContent = data.combo || data.current_gesture || "No Hand Detected";
    els.confidenceValue.textContent = (data.confidence || 0).toFixed(1) + "%";
    els.confidenceFill.style.width = (data.confidence || 0) + "%";
    els.detectionStatus.textContent = handFound ? "Hand Detected" : "Searching…";
    els.handCount.textContent = hands.length + " / 2";
    els.fpsValue.textContent = (data.fps ?? 0).toFixed(1);
    els.landmarkCount.textContent = (handFound ? hands.length * 21 : 0) + " / " + (hands.length > 1 ? 42 : 21);

    if (data.combo) {
      els.comboText.textContent = data.combo;
      els.comboBanner.hidden = false;
    } else {
      els.comboBanner.hidden = true;
    }

    els.handChips.innerHTML = hands.map((h) => {
      const side = (h.handedness || "").toLowerCase();
      return `
        <div class="hand-chip ${side}">
          <span class="chip-tag">${escapeHtml(h.handedness)}</span>
          <span class="chip-gesture">${escapeHtml(shortLabel(h.gesture))} · ${h.finger_count} finger${h.finger_count === 1 ? "" : "s"}</span>
          <span class="chip-conf">${h.confidence.toFixed(0)}%</span>
        </div>`;
    }).join("");

    els.statFrames.textContent = formatNumber(data.total_frames || 0);
    els.statGestures.textContent = formatNumber(data.total_gestures || 0);
    els.statCurrent.textContent = handFound ? shortLabel(data.combo || data.current_gesture) : "—";
    els.statAccuracy.textContent = (data.accuracy || 0).toFixed(1) + "%";

    renderHistory(data.history || []);
  }

  function shortLabel(label) {
    return (label || "").replace(" (Peace)", "");
  }

  function formatNumber(n) {
    return n.toLocaleString();
  }

  const GESTURE_ICONS = {
    "Open Palm": "fa-regular fa-hand",
    "Fist": "fa-regular fa-hand-back-fist",
    "One Finger": "fa-solid fa-hand-point-up",
    "Two Fingers (Peace)": "fa-solid fa-hand-peace",
    "Three Fingers": "fa-solid fa-hand-spock",
    "Four Fingers": "fa-regular fa-hand",
    "Thumbs Up": "fa-solid fa-thumbs-up",
    "Thumbs Down": "fa-solid fa-thumbs-down",
    "OK Sign": "fa-solid fa-circle-check",
    "Rock On": "fa-solid fa-music",
    "Call Me": "fa-solid fa-phone",
    "Double Thumbs Up!": "fa-solid fa-thumbs-up",
    "High Ten!": "fa-regular fa-hand",
    "Double Fist Bump": "fa-regular fa-hand-back-fist",
    "Double Peace": "fa-solid fa-hand-peace",
    "Double Rock On!": "fa-solid fa-music",
    "Double OK!": "fa-solid fa-circle-check",
  };

  function renderHistory(history) {
    const key = JSON.stringify(history);
    if (key === renderedHistoryKey) return;
    renderedHistoryKey = key;

    if (!history.length) {
      els.historyList.innerHTML = '<li class="history-empty">No gestures detected yet — start the camera to begin.</li>';
      return;
    }

    els.historyList.innerHTML = history.map((item) => {
      const icon = GESTURE_ICONS[item.gesture] || "fa-solid fa-hand";
      return `
        <li class="history-item">
          <span class="h-icon"><i class="${icon}"></i></span>
          <span class="h-body">
            <div class="h-name">${escapeHtml(item.gesture)}</div>
            <div class="h-time">${escapeHtml(item.time)} · ${item.fingers} finger${item.fingers === 1 ? "" : "s"}</div>
          </span>
          <span class="h-conf">${item.confidence.toFixed(0)}%</span>
        </li>`;
    }).join("");
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // -------------------------------------------------------------------
  // Theme toggle
  // -------------------------------------------------------------------
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    els.themeIcon.className = theme === "dark" ? "fa-solid fa-moon" : "fa-solid fa-sun";
    localStorage.setItem("gesturelab-theme", theme);
  }

  function initTheme() {
    const saved = localStorage.getItem("gesturelab-theme");
    const preferred = saved || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    applyTheme(preferred);
  }

  els.themeToggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    applyTheme(current === "dark" ? "light" : "dark");
  });

  // -------------------------------------------------------------------
  // Voice announcements (Web Speech API) — speaks the detected gesture
  // name out loud whenever it changes. Off by default; toggled by the
  // speaker button next to the camera controls, and remembered across
  // visits via localStorage.
  // -------------------------------------------------------------------
  const voiceToggleBtn = document.getElementById("voiceToggleBtn");
  const voiceToggleIcon = document.getElementById("voiceToggleIcon");
  const speechSupported = "speechSynthesis" in window;
  let voiceEnabled = speechSupported && localStorage.getItem("gesturelab-voice") === "on";
  let lastAnnouncedSignature = null;

  function applyVoiceButtonState() {
    voiceToggleBtn.classList.toggle("voice-active", voiceEnabled);
    voiceToggleBtn.setAttribute("aria-pressed", String(voiceEnabled));
    voiceToggleIcon.className = voiceEnabled ? "fa-solid fa-volume-high" : "fa-solid fa-volume-xmark";
    voiceToggleBtn.title = voiceEnabled ? "Voice announcements on" : "Voice announcements off";
  }

  function speak(text) {
    if (!speechSupported) return;
    window.speechSynthesis.cancel(); // don't let announcements queue up and lag behind
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
  }

  function announceGestureIfNeeded(data) {
    if (!voiceEnabled) return;
    const hands = data.hands || [];
    if (!hands.length) {
      lastAnnouncedSignature = null;
      return;
    }
    const label = data.combo || data.current_gesture;
    if (!label || label === lastAnnouncedSignature) return;
    lastAnnouncedSignature = label;
    speak(label);
  }

  if (speechSupported) {
    applyVoiceButtonState();
    voiceToggleBtn.addEventListener("click", () => {
      voiceEnabled = !voiceEnabled;
      localStorage.setItem("gesturelab-voice", voiceEnabled ? "on" : "off");
      applyVoiceButtonState();
      if (voiceEnabled) speak("Voice announcements on");
    });
  } else {
    voiceToggleBtn.disabled = true;
    voiceToggleBtn.title = "Voice announcements aren't supported in this browser";
  }

  // -------------------------------------------------------------------
  // Mobile nav
  // -------------------------------------------------------------------
  els.navToggle.addEventListener("click", () => {
    els.navLinks.classList.toggle("open");
  });

  // -------------------------------------------------------------------
  // Air Canvas controller
  // -------------------------------------------------------------------
  const canvasEls = {
    startBtn: document.getElementById("canvasStartBtn"),
    stopBtn: document.getElementById("canvasStopBtn"),
    clearBtn: document.getElementById("canvasClearBtn"),
    saveBtn: document.getElementById("canvasSaveBtn"),
    stream: document.getElementById("canvasStream"),
    placeholder: document.getElementById("canvasPlaceholder"),
    loader: document.getElementById("canvasLoader"),
    penBadge: document.getElementById("penBadge"),
    penModeValue: document.getElementById("penModeValue"),
    errorBanner: document.getElementById("canvasErrorBanner"),
    errorText: document.getElementById("canvasErrorText"),
    swatches: document.querySelectorAll("#colorSwatches .swatch"),
    thicknessSlider: document.getElementById("thicknessSlider"),
    thicknessValue: document.getElementById("thicknessValue"),
  };

  let canvasActive = false;
  let canvasPollTimer = null;

  async function startCanvas() {
    canvasEls.startBtn.disabled = true;
    hideCanvasError();
    canvasEls.loader.style.display = "flex";
    canvasEls.placeholder.style.display = "none";

    try {
      const res = await fetch("/api/canvas/start", { method: "POST" });
      const data = await res.json();
      if (!data.success) {
        showCanvasError(data.error || "Could not start the canvas camera.");
        resetCanvasUI();
        return;
      }
      canvasEls.stream.src = "/canvas_feed?t=" + Date.now();
      setTimeout(() => { canvasEls.loader.style.display = "none"; }, 900);

      canvasActive = true;
      canvasEls.stopBtn.disabled = false;
      canvasEls.clearBtn.disabled = false;
      canvasEls.saveBtn.disabled = false;
      startCanvasPolling();
    } catch (err) {
      showCanvasError("Network error while contacting the server.");
      resetCanvasUI();
    }
  }

  async function stopCanvas() {
    try { await fetch("/api/canvas/stop", { method: "POST" }); } catch (err) { /* ignore */ }
    canvasActive = false;
    stopCanvasPolling();
    resetCanvasUI();
  }

  function resetCanvasUI() {
    canvasEls.stream.removeAttribute("src");
    canvasEls.loader.style.display = "none";
    canvasEls.placeholder.style.display = "flex";
    canvasEls.startBtn.disabled = false;
    canvasEls.stopBtn.disabled = true;
    canvasEls.clearBtn.disabled = true;
    canvasEls.saveBtn.disabled = true;
    canvasEls.penBadge.textContent = "Idle";
    canvasEls.penBadge.className = "pen-badge";
    canvasEls.penModeValue.textContent = "Idle";
  }

  function showCanvasError(message) {
    canvasEls.errorText.textContent = message;
    canvasEls.errorBanner.hidden = false;
  }
  function hideCanvasError() {
    canvasEls.errorBanner.hidden = true;
  }

  function startCanvasPolling() {
    stopCanvasPolling();
    canvasPollTimer = setInterval(pollCanvasStatus, 500);
    pollCanvasStatus();
  }
  function stopCanvasPolling() {
    if (canvasPollTimer) clearInterval(canvasPollTimer);
    canvasPollTimer = null;
  }

  async function pollCanvasStatus() {
    try {
      const res = await fetch("/api/canvas/status");
      const data = await res.json();
      if (data.error && data.active === false && canvasActive) {
        showCanvasError(data.error);
        stopCanvas();
        return;
      }
      const modeLabel = { drawing: "Drawing", hover: "Pen Up", cleared: "Cleared!", idle: "Searching…" }[data.pen_mode] || "Idle";
      canvasEls.penBadge.textContent = modeLabel;
      canvasEls.penBadge.className = "pen-badge" + (data.pen_mode === "drawing" ? " drawing" : data.pen_mode === "cleared" ? " cleared" : "");
      canvasEls.penModeValue.textContent = modeLabel;
      if (data.pen_mode === "drawing") unlockBadge("artist");
    } catch (err) { /* transient */ }
  }

  canvasEls.startBtn.addEventListener("click", startCanvas);
  canvasEls.stopBtn.addEventListener("click", stopCanvas);

  canvasEls.clearBtn.addEventListener("click", async () => {
    await fetch("/api/canvas/clear", { method: "POST" });
  });

  canvasEls.saveBtn.addEventListener("click", () => {
    window.location.href = "/api/canvas/download";
  });

  canvasEls.swatches.forEach((btn) => {
    btn.addEventListener("click", async () => {
      canvasEls.swatches.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      await fetch("/api/canvas/color", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ color: btn.dataset.color }),
      });
    });
  });
  if (canvasEls.swatches.length) canvasEls.swatches[0].classList.add("active");

  canvasEls.thicknessSlider.addEventListener("input", async () => {
    const value = canvasEls.thicknessSlider.value;
    canvasEls.thicknessValue.textContent = value + "px";
    await fetch("/api/canvas/thickness", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thickness: Number(value) }),
    });
  });

  window.addEventListener("beforeunload", () => {
    if (canvasActive) navigator.sendBeacon("/api/canvas/stop");
  });

  // -------------------------------------------------------------------
  // Gesture Control Panel (slideshow + volume, driven by live gestures)
  // -------------------------------------------------------------------
  const SLIDES = [
    { title: "Sunrise Teal", from: "#00d9a6", to: "#7c5cff" },
    { title: "Amber Drift", from: "#ffb020", to: "#ff5c7c" },
    { title: "Violet Deep", from: "#7c5cff", to: "#00d9a6" },
    { title: "Rose Quartz", from: "#ff5c7c", to: "#ffb020" },
    { title: "Midnight HUD", from: "#0d1220", to: "#00d9a6" },
  ];

  const controlEls = {
    slideDisplay: document.getElementById("slideDisplay"),
    slideIndex: document.getElementById("slideIndex"),
    slideTitle: document.getElementById("slideTitle"),
    slideDots: document.getElementById("slideDots"),
    favBtn: document.getElementById("favBtn"),
    volumeFill: document.getElementById("volumeFill"),
    volumeValue: document.getElementById("volumeValue"),
    lastAction: document.getElementById("lastAction"),
  };

  const controlState = {
    index: 0,
    playing: false,
    volume: 40,
    favorites: new Set(),
    lastActionGesture: null,
  };

  function renderSlide() {
    const slide = SLIDES[controlState.index];
    controlEls.slideDisplay.style.background = `linear-gradient(135deg, ${slide.from}, ${slide.to})`;
    controlEls.slideIndex.textContent = `${controlState.index + 1} / ${SLIDES.length}`;
    controlEls.slideTitle.textContent = slide.title + (controlState.playing ? " · Playing" : "");
    controlEls.favBtn.classList.toggle("active", controlState.favorites.has(controlState.index));
    controlEls.favBtn.innerHTML = controlState.favorites.has(controlState.index)
      ? '<i class="fa-solid fa-heart"></i>' : '<i class="fa-regular fa-heart"></i>';

    controlEls.slideDots.innerHTML = SLIDES.map((_, i) =>
      `<span class="${i === controlState.index ? "active" : ""}"></span>`).join("");
  }

  function renderVolume() {
    controlEls.volumeFill.style.width = controlState.volume + "%";
    controlEls.volumeValue.textContent = controlState.volume + "%";
  }

  function announceAction(text) {
    controlEls.lastAction.textContent = text;
  }

  function nextSlide() {
    controlState.index = (controlState.index + 1) % SLIDES.length;
    renderSlide();
    announceAction("Next Slide → " + SLIDES[controlState.index].title);
  }
  function prevSlide() {
    controlState.index = (controlState.index - 1 + SLIDES.length) % SLIDES.length;
    renderSlide();
    announceAction("Previous Slide → " + SLIDES[controlState.index].title);
  }
  function togglePlay() {
    controlState.playing = !controlState.playing;
    renderSlide();
    announceAction(controlState.playing ? "Play" : "Pause");
  }
  function stopReset() {
    controlState.playing = false;
    controlState.index = 0;
    renderSlide();
    announceAction("Stop & Reset");
  }
  function volumeUp() {
    controlState.volume = Math.min(100, controlState.volume + 10);
    renderVolume();
    announceAction("Volume Up → " + controlState.volume + "%");
  }
  function volumeDown() {
    controlState.volume = Math.max(0, controlState.volume - 10);
    renderVolume();
    announceAction("Volume Down → " + controlState.volume + "%");
  }
  function toggleFavorite() {
    if (controlState.favorites.has(controlState.index)) {
      controlState.favorites.delete(controlState.index);
      announceAction("Removed Favorite");
    } else {
      controlState.favorites.add(controlState.index);
      announceAction("Added to Favorites ♥");
    }
    renderSlide();
  }

  const GESTURE_ACTIONS = {
    "Open Palm": togglePlay,
    "Fist": stopReset,
    "One Finger": nextSlide,
    "Two Fingers (Peace)": prevSlide,
    "Three Fingers": volumeUp,
    "Four Fingers": volumeDown,
    "Thumbs Up": toggleFavorite,
  };

  function handleGestureAction(data) {
    const hands = data.hands || [];
    // Only drive the control panel off unambiguous single-hand gestures —
    // two hands at once is reserved for combos in the main info card.
    if (hands.length !== 1) {
      controlState.lastActionGesture = null;
      return;
    }
    const gesture = hands[0].gesture;
    if (gesture === controlState.lastActionGesture) return; // debounce: act once per new gesture
    controlState.lastActionGesture = gesture;

    const action = GESTURE_ACTIONS[gesture];
    if (action) action();
  }

  renderSlide();
  renderVolume();

  // -------------------------------------------------------------------
  // Rock Paper Scissors game (driven by the live camera above)
  // -------------------------------------------------------------------
  const MOVE_ICONS = {
    Rock: '<i class="fa-regular fa-hand-back-fist"></i>',
    Paper: '<i class="fa-regular fa-hand"></i>',
    Scissors: '<i class="fa-solid fa-hand-peace"></i>',
  };
  const GESTURE_TO_MOVE = {
    "Fist": "Rock",
    "Open Palm": "Paper",
    "Two Fingers (Peace)": "Scissors",
  };
  const BEATS = { Rock: "Scissors", Paper: "Rock", Scissors: "Paper" };

  const rpsEls = {
    playerMove: document.getElementById("playerMove"),
    computerMove: document.getElementById("computerMove"),
    status: document.getElementById("rpsStatus"),
    result: document.getElementById("rpsResult"),
    playBtn: document.getElementById("rpsPlayBtn"),
    resetBtn: document.getElementById("rpsResetBtn"),
    wins: document.getElementById("rpsWins"),
    losses: document.getElementById("rpsLosses"),
    draws: document.getElementById("rpsDraws"),
    streak: document.getElementById("rpsStreak"),
    bestStreak: document.getElementById("rpsBestStreak"),
  };

  const rpsScore = {
    wins: 0, losses: 0, draws: 0, streak: 0,
    bestStreak: Number(localStorage.getItem("gesturelab-rps-best-streak") || 0),
  };
  let rpsInProgress = false;

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  function currentPlayerMove() {
    const hands = (latestStatsData && latestStatsData.hands) || [];
    if (hands.length !== 1) return null; // keep it unambiguous — one hand only
    return GESTURE_TO_MOVE[hands[0].gesture] || null;
  }

  async function playRpsRound() {
    if (rpsInProgress) return;
    if (!cameraActive) {
      rpsEls.status.textContent = "Start the camera above first!";
      return;
    }
    rpsInProgress = true;
    rpsEls.playBtn.disabled = true;
    rpsEls.result.textContent = "";
    rpsEls.result.className = "rps-result";
    rpsEls.playerMove.innerHTML = '<i class="fa-solid fa-question"></i>';
    rpsEls.computerMove.innerHTML = '<i class="fa-solid fa-question"></i>';
    rpsEls.playerMove.classList.remove("reveal");
    rpsEls.computerMove.classList.remove("reveal");

    for (const tick of ["Show your move…", "3", "2", "1", "GO!"]) {
      rpsEls.status.textContent = tick;
      await sleep(550);
    }

    const playerMove = currentPlayerMove();
    const computerMove = ["Rock", "Paper", "Scissors"][Math.floor(Math.random() * 3)];
    rpsEls.computerMove.innerHTML = MOVE_ICONS[computerMove];
    rpsEls.computerMove.classList.add("reveal");

    if (!playerMove) {
      rpsEls.playerMove.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      rpsEls.status.textContent = "Ready?";
      rpsEls.result.textContent = "No valid gesture seen — try Fist, Open Palm, or Two Fingers!";
      rpsEls.result.classList.add("draw");
      rpsInProgress = false;
      rpsEls.playBtn.disabled = false;
      return;
    }

    rpsEls.playerMove.innerHTML = MOVE_ICONS[playerMove];
    rpsEls.playerMove.classList.add("reveal");
    rpsEls.status.textContent = "Ready?";

    let outcome;
    let streakNote = "";
    if (playerMove === computerMove) {
      outcome = "draw";
      rpsScore.draws += 1;
      rpsEls.result.textContent = `Draw — both played ${playerMove}!`;
    } else if (BEATS[playerMove] === computerMove) {
      outcome = "win";
      rpsScore.wins += 1;
      rpsScore.streak += 1;
      unlockBadge("rps-win");
      if (rpsScore.streak >= 3) unlockBadge("rps-streak-3");
      if (rpsScore.streak > rpsScore.bestStreak) {
        rpsScore.bestStreak = rpsScore.streak;
        localStorage.setItem("gesturelab-rps-best-streak", String(rpsScore.bestStreak));
        streakNote = " 🏆 New best streak!";
      }
      rpsEls.result.textContent = `You win! ${playerMove} beats ${computerMove}.${streakNote}`;
    } else {
      outcome = "lose";
      rpsScore.losses += 1;
      rpsScore.streak = 0;
      rpsEls.result.textContent = `You lose — ${computerMove} beats ${playerMove}.`;
    }
    rpsEls.result.classList.add(outcome);
    updateRpsScoreboard();

    rpsInProgress = false;
    rpsEls.playBtn.disabled = false;
  }

  function updateRpsScoreboard() {
    rpsEls.wins.textContent = rpsScore.wins;
    rpsEls.losses.textContent = rpsScore.losses;
    rpsEls.draws.textContent = rpsScore.draws;
    rpsEls.streak.textContent = rpsScore.streak;
    rpsEls.bestStreak.textContent = rpsScore.bestStreak;
  }

  rpsEls.playBtn.addEventListener("click", playRpsRound);
  rpsEls.resetBtn.addEventListener("click", () => {
    // Best streak is an all-time record, so it survives a score reset —
    // only the current session's tallies and active streak clear.
    rpsScore.wins = 0; rpsScore.losses = 0; rpsScore.draws = 0; rpsScore.streak = 0;
    updateRpsScoreboard();
    rpsEls.result.textContent = "";
    rpsEls.result.className = "rps-result";
    rpsEls.playerMove.innerHTML = '<i class="fa-solid fa-question"></i>';
    rpsEls.computerMove.innerHTML = '<i class="fa-solid fa-question"></i>';
    rpsEls.status.textContent = "Ready?";
  });

  updateRpsScoreboard(); // reflect the persisted best streak immediately on load

  // -------------------------------------------------------------------
  // Achievement Badges — small dopamine hits for trying different
  // features. Unlocked badges persist across visits via localStorage.
  // -------------------------------------------------------------------
  const BADGES = [
    { id: "first-gesture", name: "First Steps", icon: "fa-shoe-prints", desc: "Detect your first gesture" },
    { id: "explorer-5", name: "Gesture Explorer", icon: "fa-compass", desc: "Try 5 different gestures" },
    { id: "explorer-10", name: "Gesture Master", icon: "fa-graduation-cap", desc: "Try 10 different gestures" },
    { id: "combo", name: "Combo Star", icon: "fa-bolt", desc: "Trigger a two-hand combo" },
    { id: "rock-on", name: "Rock Star", icon: "fa-music", desc: "Show the Rock On gesture" },
    { id: "century", name: "Century Club", icon: "fa-crown", desc: "Reach 100 total gestures" },
    { id: "artist", name: "Digital Artist", icon: "fa-paintbrush", desc: "Draw something in Air Canvas" },
    { id: "rps-win", name: "RPS Rookie", icon: "fa-trophy", desc: "Win a Rock Paper Scissors round" },
    { id: "rps-streak-3", name: "On Fire", icon: "fa-fire", desc: "Win 3 rounds in a row" },
  ];

  const badgeState = {
    unlocked: new Set(JSON.parse(localStorage.getItem("gesturelab-badges") || "[]")),
  };
  const gesturesSeenThisSession = new Set();

  function renderBadgeShelf() {
    const grid = document.getElementById("badgeGrid");
    if (!grid) return;
    grid.innerHTML = BADGES.map((b) => {
      const isUnlocked = badgeState.unlocked.has(b.id);
      return `
        <div class="badge-item ${isUnlocked ? "unlocked" : "locked"}" title="${escapeHtml(b.desc)}">
          <span class="badge-icon"><i class="fa-solid ${b.icon}"></i></span>
          <span class="badge-name">${escapeHtml(b.name)}</span>
          <span class="badge-desc">${isUnlocked ? escapeHtml(b.desc) : "Locked"}</span>
        </div>`;
    }).join("");
    const statBadges = document.getElementById("statBadges");
    if (statBadges) statBadges.textContent = `${badgeState.unlocked.size} / ${BADGES.length}`;
  }

  function unlockBadge(id) {
    if (badgeState.unlocked.has(id)) return;
    badgeState.unlocked.add(id);
    localStorage.setItem("gesturelab-badges", JSON.stringify([...badgeState.unlocked]));
    renderBadgeShelf();
    const badge = BADGES.find((b) => b.id === id);
    if (badge) showBadgeToast(badge);
  }

  function showBadgeToast(badge) {
    const container = document.getElementById("badgeToastContainer");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = "badge-toast";
    toast.innerHTML = `
      <span class="badge-icon"><i class="fa-solid ${badge.icon}"></i></span>
      <span>
        <div class="badge-toast-title">Achievement Unlocked</div>
        <div class="badge-toast-name">${escapeHtml(badge.name)}</div>
      </span>`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4200);
  }

  function checkGestureBadges(data) {
    const hands = data.hands || [];
    if (!hands.length) return;

    unlockBadge("first-gesture");

    hands.forEach((h) => {
      if (h.gesture) gesturesSeenThisSession.add(h.gesture);
      if (h.gesture === "Rock On") unlockBadge("rock-on");
    });
    if (gesturesSeenThisSession.size >= 5) unlockBadge("explorer-5");
    if (gesturesSeenThisSession.size >= 10) unlockBadge("explorer-10");

    if (data.combo) unlockBadge("combo");
    if ((data.total_gestures || 0) >= 100) unlockBadge("century");
  }

  renderBadgeShelf();

  // -------------------------------------------------------------------
  // Reveal on scroll
  // -------------------------------------------------------------------
  function initReveal() {
    const targets = document.querySelectorAll("section > *");
    targets.forEach((el) => el.classList.add("reveal"));
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in-view");
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    targets.forEach((el) => observer.observe(el));
  }

  // -------------------------------------------------------------------
  // Wire up + init
  // -------------------------------------------------------------------
  els.startBtn.addEventListener("click", startCamera);
  els.stopBtn.addEventListener("click", stopCamera);

  window.addEventListener("beforeunload", () => {
    if (cameraActive) {
      navigator.sendBeacon("/api/camera/stop");
    }
  });

  initTheme();
  initReveal();
  resetInfoCard();
})();
