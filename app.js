(function () {
  'use strict';

  // =========================================================================
  // CONSTANTES Y CONFIGURACIÓN
  // =========================================================================
  const STORAGE_KEY = 'pablets_broadcast_v2';
  const LEGACY_STORAGE_KEYS = [
    'pablets_broadcast_v1',
    'botonera_broadcast_jingle_palette_v4',
    'botonera_broadcast_jingle_palette_v3'
  ];
  const DB_NAME = 'PabletsBroadcastAudioDB_v2';
  const LEGACY_DB_NAMES = ['PabletsBroadcastAudioDB_v1', 'BotoneraBroadcastAudioDB_v1'];
  const DB_STORE = 'palettePadAudio';
  const META_STORE = 'appMetaHandles';
  const CONFIG_FILENAME = 'pablets-broadcast-config.json';

  const LEFT_KEYS = [
    '1', '2', '3', '4', '5',
    'Q', 'W', 'E', 'R', 'T',
    'A', 'S', 'D', 'F', 'G'
  ];

  const RIGHT_KEYS = [
    '6', '7', '8', '9', '0',
    'Y', 'U', 'I', 'O', 'P',
    'H', 'J', 'K', 'L', 'Ñ'
  ];

  const COLOR_SWATCHES = [
    '#0284c7', '#2563eb', '#4f46e5', '#7c3aed',
    '#c026d3', '#e11d48', '#dc2626', '#ea580c',
    '#d97706', '#ca8a04', '#16a34a', '#059669',
    '#0d9488', '#0891b2', '#475569', '#334155'
  ];

  const MIN_CUE_LOOP_MS = 50;
  const MAX_CUE_LOOP_MS = 10000;
  const DEFAULT_CUE_LOOP_MS = 1500;

  const MIN_SEEK_STEP_MS = 0;
  const MAX_SEEK_STEP_MS = 10000;
  const DEFAULT_SEEK_STEP_MS = 500;

  const MIN_BPM = 60.0;
  const MAX_BPM = 180.0;
  const DEFAULT_BPM = 120.0;

  const MIN_FADE_MS = 0;
  const MAX_FADE_MS = 10000;
  const DEFAULT_PALETTE_FADE_MS = 0;
  const DEFAULT_FADE_IN_MS = 250;
  const DEFAULT_FADE_OUT_MS = 500;
  const DEFAULT_INTERACTIVE_FADE_MS = 1500;

  const DEFAULT_LIMITER_ENABLED = true;
  const DEFAULT_LIMITER_DB = -9.0;
  const MIN_LIMITER_DB = -24.0;
  const MAX_LIMITER_DB = 0.0;

  // =========================================================================
  // ESTADO GLOBAL DE LA APLICACIÓN
  // =========================================================================
  function createBankEngine(bank) {
    return {
      bank,
      ctx: null,
      masterBusGain: null,
      limiterNode: null,
      ceilingShaper: null,
      masterAnalyser: null,
      masterDataArray: null,
      sinkDeviceId: '',
      channelMode: bank === 'L' ? 'ch1' : 'ch2',
      maxChannels: 2,
      fallbackAudioEl: null,
      fallbackStreamDest: null,
      fallbackSinkApplied: false
    };
  }

  const appState = {
    palettes: [],
    activePaletteByBank: {
      L: '',
      R: ''
    },
    pads: {},
    palettePadsCache: {},
    decodedAudioCache: {},
    rawAudioCache: {},
    audioBlobUrlCache: {},
    waveformPeaksCache: {},
    selectedPadId: 'L-1',
    lastTriggeredPadId: 'L-1',
    lastSelectedByBank: { L: 'L-1', R: 'R-6' },
    preservePitch: true,
    cueLoopMs: DEFAULT_CUE_LOOP_MS,
    seekStepMs: DEFAULT_SEEK_STEP_MS,
    limiter: {
      enabled: DEFAULT_LIMITER_ENABLED,
      enabledL: DEFAULT_LIMITER_ENABLED,
      enabledR: DEFAULT_LIMITER_ENABLED,
      thresholdDb: DEFAULT_LIMITER_DB,
      thresholdDbL: DEFAULT_LIMITER_DB,
      thresholdDbR: DEFAULT_LIMITER_DB
    },
    transition: {
      mode: 'cut',
      fadeInMs: DEFAULT_FADE_IN_MS,
      fadeOutMs: DEFAULT_FADE_OUT_MS,
      interactiveFadeMs: DEFAULT_INTERACTIVE_FADE_MS
    },
    routing: {
      L: { deviceId: '', deviceLabel: 'Salida predeterminada', channelMode: 'ch1' },
      R: { deviceId: '', deviceLabel: 'Salida predeterminada', channelMode: 'ch2' }
    },
    engines: {
      L: createBankEngine('L'),
      R: createBankEngine('R')
    },
    activePlaybacks: [],
    fadingPlaybacks: [],
    heldSamplerKeys: new Set(),
    heldSamplerPointers: new Map(),
    outputDevices: [],
    audioPermissionGranted: false,
    decodeCtx: null,
    db: null,
    configDirHandle: null,
    folderSaveTimer: null,
    masterVuRafId: null,
    masterVuPeakHold: { L: 0, R: 0 },
    openFadePanelByBank: { L: false, R: false },
    searchHighlightTimer: null,
    contextMenu: {
      isOpen: false,
      padId: null,
      paletteId: null,
      activeCueSlot: 0,
      cueDraftSeconds: 0,
      cueLoopActive: false,
      cueLoopTimer: null,
      cueLoopSource: null,
      cueLoopGain: null
    },
    pendingUploadTarget: null
  };

  function getPadSlotIndex(padId) {
    if (!padId) return -1;
    if (padId.startsWith('L-')) return LEFT_KEYS.indexOf(padId.slice(2));
    if (padId.startsWith('R-')) return RIGHT_KEYS.indexOf(padId.slice(2));
    return -1;
  }

  function getMirrorPadId(padId) {
    const idx = getPadSlotIndex(padId);
    if (idx < 0) return null;
    if (padId.startsWith('L-')) return `R-${RIGHT_KEYS[idx]}`;
    if (padId.startsWith('R-')) return `L-${LEFT_KEYS[idx]}`;
    return null;
  }

  function getPaletteSlotKey(paletteId, padId) {
    return `${paletteId}__${padId}`;
  }

  function getSharedSlotKey(paletteId, padId) {
    const idx = getPadSlotIndex(padId);
    return idx >= 0 ? `${paletteId}__slot_${idx}` : getPaletteSlotKey(paletteId, padId);
  }

  function getBankPaletteId(bank) {
    return appState.activePaletteByBank[bank] || (appState.palettes[0] && appState.palettes[0].id) || '';
  }

  function getPaletteById(paletteId) {
    return appState.palettes.find((p) => p.id === paletteId) || appState.palettes[0] || null;
  }

  function getBankPalette(bank) {
    return getPaletteById(getBankPaletteId(bank));
  }

  // =========================================================================
  // UTILIDADES GENERALES
  // =========================================================================
  function clamp(val, min, max) {
    return Math.min(max, Math.max(min, val));
  }

  function formatPadNumber(num) {
    return String(num).padStart(2, '0');
  }

  function formatSeconds(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return '0.0s';
    if (sec < 60) return `${sec.toFixed(1)}s`;
    const mins = Math.floor(sec / 60);
    const rem = sec % 60;
    return `${mins}:${rem < 10 ? '0' : ''}${rem.toFixed(1)}`;
  }

  function bpmToRate(bpm, detectedBpm = DEFAULT_BPM) {
    const cleanBpm = clamp(Number(bpm) || detectedBpm || DEFAULT_BPM, MIN_BPM, MAX_BPM);
    const base = clamp(Number(detectedBpm) || DEFAULT_BPM, MIN_BPM, MAX_BPM);
    return cleanBpm / base;
  }

  function normalizeTriggerMode(mode) {
    return mode === 'single' || mode === 'sampler' ? mode : 'normal';
  }

  function detectRealBPM(audioBuffer) {
    if (!audioBuffer) return DEFAULT_BPM;
    const sampleRate = audioBuffer.sampleRate || 44100;
    const channelData = audioBuffer.getChannelData(0);
    if (!channelData || channelData.length < sampleRate * 1.5) return DEFAULT_BPM;

    const blockSize = Math.max(1, Math.floor(sampleRate * 0.02));
    const energies = [];

    for (let i = 0; i < channelData.length; i += blockSize) {
      let sumSq = 0;
      const end = Math.min(i + blockSize, channelData.length);
      for (let j = i; j < end; j++) {
        const s = channelData[j];
        sumSq += s * s;
      }
      energies.push(Math.sqrt(sumSq / (end - i)));
    }

    if (energies.length < 15) return DEFAULT_BPM;

    const avg = energies.reduce((a, b) => a + b, 0) / energies.length;
    const variance =
      energies.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / energies.length;
    const threshold = avg + Math.sqrt(variance) * 0.7;

    const peakTimes = [];
    const blockDurationSec = blockSize / sampleRate;
    const minPeakGapSec = 0.28;
    let lastPeakTime = -Infinity;

    for (let i = 1; i < energies.length - 1; i++) {
      if (
        energies[i] > threshold &&
        energies[i] >= energies[i - 1] &&
        energies[i] >= energies[i + 1]
      ) {
        const t = i * blockDurationSec;
        if (t - lastPeakTime >= minPeakGapSec) {
          peakTimes.push(t);
          lastPeakTime = t;
        }
      }
    }

    if (peakTimes.length < 2) return DEFAULT_BPM;

    const bpmCounts = new Map();
    for (let i = 0; i < peakTimes.length; i++) {
      for (let j = i + 1; j < Math.min(i + 10, peakTimes.length); j++) {
        const dt = peakTimes[j] - peakTimes[i];
        if (dt <= 0) continue;
        let bpm = 60 / dt;
        while (bpm < 70) bpm *= 2;
        while (bpm > 175) bpm /= 2;
        const rounded = Math.round(bpm * 2) / 2;
        bpmCounts.set(rounded, (bpmCounts.get(rounded) || 0) + 1);
      }
    }

    if (bpmCounts.size === 0) return DEFAULT_BPM;

    let bestBpm = DEFAULT_BPM;
    let bestCount = -1;
    for (const [bpm, count] of bpmCounts.entries()) {
      if (count > bestCount) {
        bestCount = count;
        bestBpm = bpm;
      }
    }

    return clamp(bestBpm, MIN_BPM, MAX_BPM);
  }

  function normalizeCuesArray(rawCues, legacyCueStart = 0) {
    const result = [null, null, null];
    if (Array.isArray(rawCues)) {
      for (let i = 0; i < 3; i++) {
        const val = rawCues[i];
        if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
          result[i] = val;
        }
      }
    }
    if (result[0] === null && typeof legacyCueStart === 'number' && legacyCueStart > 0) {
      result[0] = legacyCueStart;
    }
    return result;
  }

  function getPrimaryCueSeconds(pad) {
    if (!pad) return 0;
    const cues = normalizeCuesArray(pad.cues, pad.cueStart);
    for (let i = 0; i < 3; i++) {
      if (typeof cues[i] === 'number' && cues[i] >= 0) {
        return cues[i];
      }
    }
    return Math.max(0, Number(pad.cueStart) || 0);
  }

  function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const colorClasses =
      type === 'success'
        ? 'bg-emerald-950/95 border-emerald-400/50 text-emerald-200'
        : type === 'warning'
          ? 'bg-amber-950/95 border-amber-400/50 text-amber-200'
          : type === 'error'
            ? 'bg-rose-950/95 border-rose-400/50 text-rose-200'
            : 'bg-slate-900/95 border-sky-400/40 text-slate-100';

    const toast = document.createElement('div');
    toast.className = `px-3.5 py-2 rounded-xl border shadow-xl text-xs font-medium transition-opacity duration-200 ${colorClasses}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 220);
    }, 2500);
  }

  function isTypingInFormField(target) {
    if (!target) return false;
    const tag = target.tagName ? target.tagName.toUpperCase() : '';
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  // =========================================================================
  // GUARDADO EN CARPETA LOCAL ELEGIDA POR EL USUARIO (File System Access API)
  // =========================================================================
  function updateConfigFolderBadge() {
    const btn = document.getElementById('selectConfigFolderBtn');
    if (!btn) return;
    if (appState.configDirHandle && appState.configDirHandle.name) {
      btn.textContent = `📁 Carpeta: ${appState.configDirHandle.name}`;
      btn.className =
        'px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-500/25 hover:bg-emerald-500/35 text-emerald-200 border border-emerald-400/55 cursor-pointer transition';
    } else {
      btn.textContent = '📁 Carpeta Config: Elegir';
      btn.className =
        'px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-emerald-500/40 cursor-pointer transition';
    }
  }

  async function saveDirectoryHandleToDB(dirHandle) {
    try {
      const db = await openAudioDatabase();
      if (!db.objectStoreNames.contains(META_STORE)) return;
      const tx = db.transaction(META_STORE, 'readwrite');
      tx.objectStore(META_STORE).put({ key: 'configDirHandle', handle: dirHandle });
    } catch (_) {}
  }

  async function restoreDirectoryHandleFromDB() {
    try {
      const db = await openAudioDatabase();
      if (!db.objectStoreNames.contains(META_STORE)) return null;
      return await new Promise((resolve) => {
        const tx = db.transaction(META_STORE, 'readonly');
        const req = tx.objectStore(META_STORE).get('configDirHandle');
        req.onsuccess = () => resolve((req.result && req.result.handle) || null);
        req.onerror = () => resolve(null);
      });
    } catch (_) {
      return null;
    }
  }

  async function verifyDirectoryPermission(dirHandle, promptUser = false) {
    if (!dirHandle) return false;
    try {
      const opts = { mode: 'readwrite' };
      if ((await dirHandle.queryPermission(opts)) === 'granted') return true;
      if (promptUser && (await dirHandle.requestPermission(opts)) === 'granted') return true;
    } catch (_) {}
    return false;
  }

  async function writeAudioFileToLocalFolder(paletteId, padId, fileName, arrayBuffer) {
    if (!appState.configDirHandle || !arrayBuffer) return;
    const hasPerm = await verifyDirectoryPermission(appState.configDirHandle, false);
    if (!hasPerm) return;

    try {
      const audiosDir = await appState.configDirHandle.getDirectoryHandle('audios', { create: true });
      const safeName = `${paletteId}_${padId}_${(fileName || 'audio.mp3').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const fileHandle = await audiosDir.getFileHandle(safeName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(arrayBuffer.slice(0));
      await writable.close();
    } catch (err) {
      console.warn('No se pudo copiar el audio a la carpeta local:', err);
    }
  }

  async function syncAllStateAndAudiosToLocalFolder(dirHandle) {
    if (!dirHandle) return;
    const hasPerm = await verifyDirectoryPermission(dirHandle, true);
    if (!hasPerm) {
      showToast('Permiso denegado para escribir en la carpeta seleccionada.', 'warning');
      return;
    }

    const payload = buildSerializablePayload();
    try {
      const cfgHandle = await dirHandle.getFileHandle(CONFIG_FILENAME, { create: true });
      const writable = await cfgHandle.createWritable();
      await writable.write(JSON.stringify(payload, null, 2));
      await writable.close();

      // Guardar también los audios activos en subcarpeta audios/
      for (const pal of appState.palettes) {
        const padIds = Object.keys(pal.pads || {});
        for (const padId of padIds) {
          const cfg = pal.pads[padId];
          if (!cfg || !cfg.fileName) continue;
          const slotKey = getPaletteSlotKey(pal.id, padId);
          const rawBuf = appState.rawAudioCache[slotKey];
          if (rawBuf) {
            await writeAudioFileToLocalFolder(pal.id, padId, cfg.fileName, rawBuf);
          } else {
            const rec = await loadAudioFromIndexedDB(pal.id, padId);
            if (rec && rec.data) {
              await writeAudioFileToLocalFolder(pal.id, padId, rec.fileName || cfg.fileName, rec.data);
            }
          }
        }
      }
    } catch (err) {
      console.warn('Error escribiendo carpeta local:', err);
    }
  }

  async function loadConfigFromLocalFolderIfAvailable(dirHandle) {
    if (!dirHandle) return false;
    const hasPerm = await verifyDirectoryPermission(dirHandle, false);
    if (!hasPerm) return false;

    try {
      const cfgHandle = await dirHandle.getFileHandle(CONFIG_FILENAME, { create: false });
      const file = await cfgHandle.getFile();
      const text = await file.text();
      if (!text) return false;
      localStorage.setItem(STORAGE_KEY, text);
      loadSavedState();

      // Restaurar archivos de audio desde carpeta audios/ si no están en IndexedDB
      try {
        const audiosDir = await dirHandle.getDirectoryHandle('audios', { create: false });
        for (const pal of appState.palettes) {
          for (const padId of Object.keys(pal.pads || {})) {
            const cfg = pal.pads[padId];
            if (!cfg || !cfg.fileName) continue;
            const existing = await loadAudioFromIndexedDB(pal.id, padId);
            if (existing && existing.data) continue;

            const safeName = `${pal.id}_${padId}_${cfg.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
            try {
              const fHandle = await audiosDir.getFileHandle(safeName, { create: false });
              const fObj = await fHandle.getFile();
              const buf = await fObj.arrayBuffer();
              await saveAudioToIndexedDB(pal.id, padId, buf, cfg.fileName);
            } catch (_) {}
          }
        }
      } catch (_) {}

      return true;
    } catch (_) {
      return false;
    }
  }

  function scheduleLocalFolderSave() {
    if (!appState.configDirHandle) return;
    if (appState.folderSaveTimer) clearTimeout(appState.folderSaveTimer);
    appState.folderSaveTimer = setTimeout(async () => {
      try {
        const hasPerm = await verifyDirectoryPermission(appState.configDirHandle, false);
        if (!hasPerm) return;
        const payload = buildSerializablePayload();
        const cfgHandle = await appState.configDirHandle.getFileHandle(CONFIG_FILENAME, { create: true });
        const writable = await cfgHandle.createWritable();
        await writable.write(JSON.stringify(payload, null, 2));
        await writable.close();
      } catch (err) {
        console.warn('Error guardando JSON en carpeta local:', err);
      }
    }, 300);
  }

  async function promptSelectConfigFolder() {
    if (typeof window.showDirectoryPicker !== 'function') {
      // Respaldo descargando archivo JSON si el navegador no soporta showDirectoryPicker
      const payload = buildSerializablePayload();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = CONFIG_FILENAME;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Descargado archivo JSON de configuración (usa Chrome/Edge en Windows para vincular carpeta directa).', 'info');
      return;
    }

    try {
      const dirHandle = await window.showDirectoryPicker({
        id: 'pablets-broadcast-config-folder',
        mode: 'readwrite'
      });
      appState.configDirHandle = dirHandle;
      await saveDirectoryHandleToDB(dirHandle);
      updateConfigFolderBadge();

      // Si ya existía configuración previa en esa carpeta, preguntar o cargar si está vacía la actual; si no, guardar todo ahí
      const loadedFromFolder = await loadConfigFromLocalFolderIfAvailable(dirHandle);
      if (loadedFromFolder) {
        rebuildBankPadsFromPalette('L', getBankPalette('L'));
        rebuildBankPadsFromPalette('R', getBankPalette('R'));
        renderPaletteSelectorsUI();
        renderAllPadGrids();
        renderTransitionModeUI();
        renderLimiterUI();
        renderAudioRoutingUI();
        await hydrateBankPaletteAudiosFromDB('L', getBankPalette('L'));
        await hydrateBankPaletteAudiosFromDB('R', getBankPalette('R'));
        showToast(`Configuración y audios cargados desde "${dirHandle.name}".`, 'success');
      } else {
        await syncAllStateAndAudiosToLocalFolder(dirHandle);
        showToast(`Carpeta "${dirHandle.name}" vinculada: todas las configuraciones y audios se guardan ahí.`, 'success');
      }
    } catch (err) {
      if (err && err.name !== 'AbortError') {
        showToast('No se pudo abrir la carpeta seleccionada.', 'warning');
      }
    }
  }

  // =========================================================================
  // ESTRUCTURA DE PALETAS Y BOTONES (30 BOTONES: 15 L + 15 R)
  // =========================================================================
  function createDefaultPadConfigs() {
    const configs = {};

    LEFT_KEYS.forEach((key, idx) => {
      const num = idx + 1;
      const id = `L-${key}`;
      configs[id] = {
        id,
        channel: 'L',
        number: num,
        key,
        label: `Jingle L ${formatPadNumber(num)}`,
        color: COLOR_SWATCHES[idx % COLOR_SWATCHES.length],
        volume: 1.0,
        bpm: DEFAULT_BPM,
        detectedBpm: DEFAULT_BPM,
        triggerMode: 'normal',
        bucle: false,
        cueStart: 0,
        cues: [null, null, null],
        duration: 0,
        fileName: '',
        hasAudio: false
      };
    });

    RIGHT_KEYS.forEach((key, idx) => {
      const num = idx + 1;
      const id = `R-${key}`;
      // Usa el mismo índice de color base para que al abrir la paleta en L o R respete el color
      configs[id] = {
        id,
        channel: 'R',
        number: num,
        key,
        label: `Jingle R ${formatPadNumber(num)}`,
        color: COLOR_SWATCHES[idx % COLOR_SWATCHES.length],
        volume: 1.0,
        bpm: DEFAULT_BPM,
        detectedBpm: DEFAULT_BPM,
        triggerMode: 'normal',
        bucle: false,
        cueStart: 0,
        cues: [null, null, null],
        duration: 0,
        fileName: '',
        hasAudio: false
      };
    });

    return configs;
  }

  function buildSharedButtonsArray(padsMap = {}) {
    const base = createDefaultPadConfigs();
    return Object.keys(base).map((padId) => {
      const cfg = padsMap[padId] || base[padId];
      return {
        id: padId,
        canal: cfg.channel,
        tecla: cfg.key,
        titulo: cfg.label || base[padId].label,
        color: cfg.color || base[padId].color,
        triggerMode: normalizeTriggerMode(cfg.triggerMode),
        src: cfg.fileName || '',
        loop: Boolean(cfg.bucle)
      };
    });
  }

  function normalizePaletteRecord(pal, idx = 0) {
    const basePads = createDefaultPadConfigs();
    const clonedPads = {};

    Object.keys(basePads).forEach((padId) => {
      const srcPad = (pal && pal.pads && pal.pads[padId]) || basePads[padId];
      const resolvedBpm =
        typeof srcPad.bpm === 'number' ? clamp(srcPad.bpm, MIN_BPM, MAX_BPM) : DEFAULT_BPM;
      const resolvedDetected =
        typeof srcPad.detectedBpm === 'number'
          ? clamp(srcPad.detectedBpm, MIN_BPM, MAX_BPM)
          : resolvedBpm;
      const normCues = normalizeCuesArray(srcPad.cues, srcPad.cueStart);

      clonedPads[padId] = {
        ...basePads[padId],
        ...srcPad,
        color: srcPad.color || basePads[padId].color,
        volume: clamp(typeof srcPad.volume === 'number' ? srcPad.volume : 1, 0, 1),
        bpm: resolvedBpm,
        detectedBpm: resolvedDetected,
        triggerMode: normalizeTriggerMode(srcPad.triggerMode),
        bucle: Boolean(srcPad.bucle),
        cueStart: Math.max(0, Number(srcPad.cueStart) || 0),
        cues: normCues,
        duration: Math.max(0, Number(srcPad.duration) || 0)
      };
    });

    if (pal && Array.isArray(pal.botones)) {
      pal.botones.forEach((btn) => {
        if (!btn || !btn.id || !clonedPads[btn.id]) return;
        if (typeof btn.titulo === 'string' && btn.titulo.trim()) {
          clonedPads[btn.id].label = btn.titulo.trim();
        }
        if (typeof btn.color === 'string' && btn.color.trim()) {
          clonedPads[btn.id].color = btn.color.trim();
        }
        if (typeof btn.triggerMode === 'string') {
          clonedPads[btn.id].triggerMode = normalizeTriggerMode(btn.triggerMode);
        }
        if (typeof btn.src === 'string') {
          clonedPads[btn.id].fileName = btn.src;
          clonedPads[btn.id].hasAudio = Boolean(btn.src) || clonedPads[btn.id].hasAudio;
        }
        if (typeof btn.loop === 'boolean') {
          clonedPads[btn.id].bucle = btn.loop;
        }
      });
    }

    // Sincronizar cada slot (0..14) entre L y R incluyendo el COLOR para que se respete al abrir del otro lado
    for (let slotIdx = 0; slotIdx < 15; slotIdx++) {
      const leftId = `L-${LEFT_KEYS[slotIdx]}`;
      const rightId = `R-${RIGHT_KEYS[slotIdx]}`;
      const lCfg = clonedPads[leftId];
      const rCfg = clonedPads[rightId];
      if (!lCfg || !rCfg) continue;

      const lHasContent = Boolean(lCfg.fileName || lCfg.hasAudio || lCfg.duration > 0);
      const rHasContent = Boolean(rCfg.fileName || rCfg.hasAudio || rCfg.duration > 0);
      const sourceCfg = lHasContent ? lCfg : rHasContent ? rCfg : lCfg;
      const sharedColor = sourceCfg.color || lCfg.color || rCfg.color || basePads[leftId].color;

      [leftId, rightId].forEach((targetId) => {
        const baseDef = basePads[targetId];
        const curDef = clonedPads[targetId];
        clonedPads[targetId] = {
          ...baseDef,
          ...curDef,
          label: sourceCfg.label || baseDef.label,
          color: sharedColor,
          volume: typeof sourceCfg.volume === 'number' ? sourceCfg.volume : curDef.volume,
          bpm: typeof sourceCfg.bpm === 'number' ? sourceCfg.bpm : curDef.bpm,
          detectedBpm:
            typeof sourceCfg.detectedBpm === 'number'
              ? sourceCfg.detectedBpm
              : curDef.detectedBpm,
          triggerMode: normalizeTriggerMode(sourceCfg.triggerMode),
          bucle: Boolean(sourceCfg.bucle),
          cueStart: Math.max(0, Number(sourceCfg.cueStart) || 0),
          cues: normalizeCuesArray(sourceCfg.cues, sourceCfg.cueStart),
          duration: Math.max(0, Number(sourceCfg.duration) || 0),
          fileName: sourceCfg.fileName || '',
          hasAudio: Boolean(sourceCfg.hasAudio || sourceCfg.fileName)
        };
      });
    }

    const cleanName =
      (pal && typeof pal.nombre === 'string' && pal.nombre.trim()) ||
      (pal && typeof pal.name === 'string' && pal.name.trim()) ||
      `Paleta ${idx + 1}`;

    return {
      id: (pal && pal.id) || `pal_${Date.now()}_${idx}`,
      name: cleanName,
      nombre: cleanName,
      fadeMs: clamp(Math.round(Number(pal && pal.fadeMs) || 0), MIN_FADE_MS, MAX_FADE_MS),
      pads: clonedPads,
      botones: buildSharedButtonsArray(clonedPads)
    };
  }

  function createPaletteObject(name, idSuffix = '') {
    const id = `pal_${Date.now()}_${idSuffix || Math.random().toString(36).slice(2, 7)}`;
    const cleanName = (name && String(name).trim()) || 'Paleta Principal';
    return normalizePaletteRecord({
      id,
      name: cleanName,
      nombre: cleanName,
      fadeMs: DEFAULT_PALETTE_FADE_MS,
      pads: createDefaultPadConfigs()
    });
  }

  // =========================================================================
  // PERSISTENCIA EN LOCALSTORAGE, INDEXEDDB Y CARPETA LOCAL
  // =========================================================================
  function syncRuntimePadsIntoPaletteConfig(bank) {
    const bankPal = getBankPalette(bank);
    if (!bankPal) return;
    const prefix = `${bank}-`;
    const freshBase = createDefaultPadConfigs();

    Object.keys(freshBase)
      .filter((padId) => padId.startsWith(prefix))
      .forEach((padId) => {
        const runtimePad = appState.pads[padId];
        if (!runtimePad) return;
        const slotKey = getPaletteSlotKey(bankPal.id, padId);
        const existingCfg = bankPal.pads[padId] || freshBase[padId];
        const normCues = normalizeCuesArray(runtimePad.cues, runtimePad.cueStart);
        const primaryCue = getPrimaryCueSeconds(runtimePad);

        const sharedKey = getSharedSlotKey(bankPal.id, padId);
        const hasAudioFlag = Boolean(
          runtimePad.audioBuffer ||
          appState.decodedAudioCache[slotKey] ||
          appState.decodedAudioCache[sharedKey] ||
          runtimePad.fileName
        );
        const syncedCfg = {
          ...freshBase[padId],
          ...existingCfg,
          id: padId,
          channel: runtimePad.channel,
          number: runtimePad.number,
          key: runtimePad.key,
          label: runtimePad.label,
          color: runtimePad.color,
          volume: clamp(runtimePad.volume, 0, 1),
          bpm: clamp(Number(runtimePad.bpm) || DEFAULT_BPM, MIN_BPM, MAX_BPM),
          detectedBpm: clamp(Number(runtimePad.detectedBpm) || Number(runtimePad.bpm) || DEFAULT_BPM, MIN_BPM, MAX_BPM),
          triggerMode: normalizeTriggerMode(runtimePad.triggerMode),
          bucle: Boolean(runtimePad.bucle),
          cueStart: primaryCue,
          cues: normCues,
          duration: Math.max(0, runtimePad.duration || 0),
          fileName: runtimePad.fileName || '',
          hasAudio: hasAudioFlag
        };
        bankPal.pads[padId] = syncedCfg;

        // Sincronizar también el espejo en el otro lado (incluyendo el color)
        const mirrorId = getMirrorPadId(padId);
        if (mirrorId && freshBase[mirrorId]) {
          const mirrorExisting = bankPal.pads[mirrorId] || freshBase[mirrorId];
          bankPal.pads[mirrorId] = {
            ...freshBase[mirrorId],
            ...mirrorExisting,
            id: mirrorId,
            channel: freshBase[mirrorId].channel,
            number: freshBase[mirrorId].number,
            key: freshBase[mirrorId].key,
            label: runtimePad.label,
            color: runtimePad.color,
            volume: clamp(runtimePad.volume, 0, 1),
            bpm: clamp(Number(runtimePad.bpm) || DEFAULT_BPM, MIN_BPM, MAX_BPM),
            detectedBpm: clamp(Number(runtimePad.detectedBpm) || Number(runtimePad.bpm) || DEFAULT_BPM, MIN_BPM, MAX_BPM),
            triggerMode: normalizeTriggerMode(runtimePad.triggerMode),
            bucle: Boolean(runtimePad.bucle),
            cueStart: primaryCue,
            cues: [...normCues],
            duration: Math.max(0, runtimePad.duration || 0),
            fileName: runtimePad.fileName || '',
            hasAudio: hasAudioFlag
          };

          const palCache = appState.palettePadsCache[bankPal.id];
          if (palCache && palCache[mirrorId]) {
            palCache[mirrorId].color = runtimePad.color;
            palCache[mirrorId].label = runtimePad.label;
            palCache[mirrorId].volume = syncedCfg.volume;
            palCache[mirrorId].bpm = syncedCfg.bpm;
            palCache[mirrorId].detectedBpm = syncedCfg.detectedBpm;
            palCache[mirrorId].triggerMode = syncedCfg.triggerMode;
            palCache[mirrorId].bucle = syncedCfg.bucle;
            palCache[mirrorId].cues = [...normCues];
            palCache[mirrorId].cueStart = primaryCue;
          }
          if (appState.pads[mirrorId] && appState.pads[mirrorId].paletteId === bankPal.id) {
            appState.pads[mirrorId].color = runtimePad.color;
            appState.pads[mirrorId].label = runtimePad.label;
            appState.pads[mirrorId].triggerMode = syncedCfg.triggerMode;
            renderPadVisuals(appState.pads[mirrorId]);
          }
        }
      });
    bankPal.nombre = bankPal.name;
    bankPal.botones = buildSharedButtonsArray(bankPal.pads);
  }

  function buildSerializablePayload() {
    syncRuntimePadsIntoPaletteConfig('L');
    syncRuntimePadsIntoPaletteConfig('R');

    const serializedPalettes = appState.palettes.map((pal) => {
      const basePads = createDefaultPadConfigs();
      const clonedPads = {};
      Object.keys(basePads).forEach((padId) => {
        const src = (pal.pads && pal.pads[padId]) || basePads[padId];
        const resolvedBpm =
          typeof src.bpm === 'number' ? clamp(src.bpm, MIN_BPM, MAX_BPM) : DEFAULT_BPM;
        const resolvedDetected =
          typeof src.detectedBpm === 'number'
            ? clamp(src.detectedBpm, MIN_BPM, MAX_BPM)
            : resolvedBpm;
        const normCues = normalizeCuesArray(src.cues, src.cueStart);
        clonedPads[padId] = {
          ...basePads[padId],
          ...src,
          color: src.color || basePads[padId].color,
          volume: clamp(typeof src.volume === 'number' ? src.volume : 1, 0, 1),
          bpm: resolvedBpm,
          detectedBpm: resolvedDetected,
          triggerMode: normalizeTriggerMode(src.triggerMode),
          bucle: Boolean(src.bucle),
          cueStart: Math.max(0, Number(src.cueStart) || 0),
          cues: normCues,
          duration: Math.max(0, Number(src.duration) || 0)
        };
      });
      const cleanPalName = (pal.nombre || pal.name || 'Paleta').trim();
      pal.name = cleanPalName;
      pal.nombre = cleanPalName;
      return {
        id: pal.id,
        name: cleanPalName,
        nombre: cleanPalName,
        fadeMs: clamp(Math.round(Number(pal.fadeMs) || 0), MIN_FADE_MS, MAX_FADE_MS),
        pads: clonedPads,
        botones: buildSharedButtonsArray(clonedPads)
      };
    });

    return {
      version: 2,
      savedAt: new Date().toISOString(),
      palettes: serializedPalettes,
      activePaletteByBank: {
        L: getBankPaletteId('L'),
        R: getBankPaletteId('R')
      },
      preservePitch: Boolean(appState.preservePitch),
      cueLoopMs: clamp(appState.cueLoopMs, MIN_CUE_LOOP_MS, MAX_CUE_LOOP_MS),
      seekStepMs: clamp(appState.seekStepMs, MIN_SEEK_STEP_MS, MAX_SEEK_STEP_MS),
      limiter: {
        enabled: Boolean(appState.limiter.enabled),
        enabledL: Boolean(appState.limiter.enabledL),
        enabledR: Boolean(appState.limiter.enabledR),
        thresholdDb: clamp(Number(appState.limiter.thresholdDb), MIN_LIMITER_DB, MAX_LIMITER_DB),
        thresholdDbL: clamp(Number(appState.limiter.thresholdDbL), MIN_LIMITER_DB, MAX_LIMITER_DB),
        thresholdDbR: clamp(Number(appState.limiter.thresholdDbR), MIN_LIMITER_DB, MAX_LIMITER_DB)
      },
      transition: {
        mode: appState.transition.mode === 'fade' ? 'fade' : 'cut',
        fadeInMs: clamp(Math.round(appState.transition.fadeInMs), MIN_FADE_MS, MAX_FADE_MS),
        fadeOutMs: clamp(Math.round(appState.transition.fadeOutMs), MIN_FADE_MS, MAX_FADE_MS),
        interactiveFadeMs: clamp(Math.round(appState.transition.interactiveFadeMs || DEFAULT_INTERACTIVE_FADE_MS), 50, 15000)
      },
      routing: appState.routing,
      selectedPadId: appState.selectedPadId
    };
  }

  function saveAllState() {
    try {
      const payload = buildSerializablePayload();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      scheduleLocalFolderSave();
    } catch (err) {
      console.warn('No se pudo guardar la configuración en localStorage:', err);
    }
  }

  function loadSavedState() {
    try {
      let raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        for (const legacyKey of LEGACY_STORAGE_KEYS) {
          const found = localStorage.getItem(legacyKey);
          if (found) {
            raw = found;
            break;
          }
        }
      }

      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.palettes) && parsed.palettes.length > 0) {
          appState.palettes = parsed.palettes.map((pal, idx) => {
            const basePads = createDefaultPadConfigs();
            if (pal && pal.pads && typeof pal.pads === 'object') {
              Object.keys(basePads).forEach((padId) => {
                if (pal.pads[padId]) {
                  const srcPad = pal.pads[padId];
                  const resolvedBpm =
                    typeof srcPad.bpm === 'number'
                      ? clamp(srcPad.bpm, MIN_BPM, MAX_BPM)
                      : DEFAULT_BPM;
                  const resolvedDetected =
                    typeof srcPad.detectedBpm === 'number'
                      ? clamp(srcPad.detectedBpm, MIN_BPM, MAX_BPM)
                      : resolvedBpm;
                  const normCues = normalizeCuesArray(srcPad.cues, srcPad.cueStart);
                  basePads[padId] = {
                    ...basePads[padId],
                    ...srcPad,
                    color: srcPad.color || basePads[padId].color,
                    volume: clamp(
                      typeof srcPad.volume === 'number' ? srcPad.volume : 1,
                      0,
                      1
                    ),
                    bpm: resolvedBpm,
                    detectedBpm: resolvedDetected,
                    triggerMode: normalizeTriggerMode(srcPad.triggerMode),
                    bucle: Boolean(srcPad.bucle),
                    cueStart: Math.max(0, Number(srcPad.cueStart) || 0),
                    cues: normCues,
                    duration: Math.max(0, Number(srcPad.duration) || 0)
                  };
                }
              });
            }
            return normalizePaletteRecord({
              ...pal,
              id: pal.id || `pal_restored_${idx}`,
              name:
                (pal && typeof pal.nombre === 'string' && pal.nombre.trim()) ||
                (pal && typeof pal.name === 'string' && pal.name.trim()) ||
                `Paleta ${idx + 1}`,
              fadeMs: clamp(Math.round(Number(pal && pal.fadeMs) || 0), MIN_FADE_MS, MAX_FADE_MS),
              pads: basePads
            }, idx);
          });

          const fallbackId = appState.palettes[0].id;
          if (parsed.activePaletteByBank && typeof parsed.activePaletteByBank === 'object') {
            appState.activePaletteByBank.L = appState.palettes.some(
              (p) => p.id === parsed.activePaletteByBank.L
            )
              ? parsed.activePaletteByBank.L
              : fallbackId;
            appState.activePaletteByBank.R = appState.palettes.some(
              (p) => p.id === parsed.activePaletteByBank.R
            )
              ? parsed.activePaletteByBank.R
              : fallbackId;
          } else {
            const singleActive = appState.palettes.some((p) => p.id === parsed.activePaletteId)
              ? parsed.activePaletteId
              : fallbackId;
            appState.activePaletteByBank.L = singleActive;
            appState.activePaletteByBank.R = singleActive;
          }
        }

        if (typeof parsed.cueLoopMs === 'number') {
          appState.cueLoopMs = clamp(parsed.cueLoopMs, MIN_CUE_LOOP_MS, MAX_CUE_LOOP_MS);
        }
        if (typeof parsed.preservePitch === 'boolean') {
          appState.preservePitch = parsed.preservePitch;
        }
        if (typeof parsed.seekStepMs === 'number') {
          appState.seekStepMs = clamp(parsed.seekStepMs, MIN_SEEK_STEP_MS, MAX_SEEK_STEP_MS);
        }
        if (parsed.limiter && typeof parsed.limiter === 'object') {
          if (typeof parsed.limiter.enabled === 'boolean') {
            appState.limiter.enabled = parsed.limiter.enabled;
          }
          if (typeof parsed.limiter.enabledL === 'boolean') {
            appState.limiter.enabledL = parsed.limiter.enabledL;
          }
          if (typeof parsed.limiter.enabledR === 'boolean') {
            appState.limiter.enabledR = parsed.limiter.enabledR;
          }
          if (typeof parsed.limiter.thresholdDb === 'number') {
            appState.limiter.thresholdDb = clamp(
              parsed.limiter.thresholdDb,
              MIN_LIMITER_DB,
              MAX_LIMITER_DB
            );
          }
          if (typeof parsed.limiter.thresholdDbL === 'number') {
            appState.limiter.thresholdDbL = clamp(
              parsed.limiter.thresholdDbL,
              MIN_LIMITER_DB,
              MAX_LIMITER_DB
            );
          }
          if (typeof parsed.limiter.thresholdDbR === 'number') {
            appState.limiter.thresholdDbR = clamp(
              parsed.limiter.thresholdDbR,
              MIN_LIMITER_DB,
              MAX_LIMITER_DB
            );
          }
        }
        if (parsed.transition && typeof parsed.transition === 'object') {
          appState.transition.mode = parsed.transition.mode === 'fade' ? 'fade' : 'cut';
          if (typeof parsed.transition.fadeInMs === 'number') {
            appState.transition.fadeInMs = clamp(
              Math.round(parsed.transition.fadeInMs),
              MIN_FADE_MS,
              MAX_FADE_MS
            );
          }
          if (typeof parsed.transition.fadeOutMs === 'number') {
            appState.transition.fadeOutMs = clamp(
              Math.round(parsed.transition.fadeOutMs),
              MIN_FADE_MS,
              MAX_FADE_MS
            );
          }
          if (typeof parsed.transition.interactiveFadeMs === 'number') {
            appState.transition.interactiveFadeMs = clamp(
              Math.round(parsed.transition.interactiveFadeMs),
              50,
              15000
            );
          }
        }
        if (parsed.routing && typeof parsed.routing === 'object') {
          if (parsed.routing.L) {
            appState.routing.L = { ...appState.routing.L, ...parsed.routing.L };
          }
          if (parsed.routing.R) {
            appState.routing.R = { ...appState.routing.R, ...parsed.routing.R };
          }
        }
        if (typeof parsed.selectedPadId === 'string') {
          appState.selectedPadId = parsed.selectedPadId;
        }
      }
    } catch (err) {
      console.warn('Error al cargar configuración previa:', err);
    }

    if (!appState.palettes.length) {
      const initial = createPaletteObject('Paleta 1', 'init');
      appState.palettes = [initial];
      appState.activePaletteByBank.L = initial.id;
      appState.activePaletteByBank.R = initial.id;
    }
  }

  function openSingleDB(dbName) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 2);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE, { keyPath: 'slotKey' });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = (event) => resolve(event.target.result);
      req.onerror = () => reject(req.error || new Error(`Error abriendo ${dbName}`));
    });
  }

  function openAudioDatabase() {
    return new Promise(async (resolve, reject) => {
      if (appState.db) {
        resolve(appState.db);
        return;
      }
      if (!window.indexedDB) {
        reject(new Error('IndexedDB no disponible en este entorno.'));
        return;
      }
      try {
        appState.db = await openSingleDB(DB_NAME);
        resolve(appState.db);
      } catch (err) {
        reject(err);
      }
    });
  }

  async function saveAudioToIndexedDB(paletteId, padId, arrayBuffer, fileName) {
    const db = await openAudioDatabase();
    const slotKey = getPaletteSlotKey(paletteId, padId);
    const clonedBuffer = arrayBuffer.slice(0);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      store.put({
        slotKey,
        paletteId,
        padId,
        fileName,
        data: clonedBuffer,
        updatedAt: Date.now()
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Error guardando audio en IndexedDB'));
    });
  }

  function getRecordFromDBInstance(db, paletteId, padId) {
    const slotKey = getPaletteSlotKey(paletteId, padId);
    const legacyKey = `${paletteId}::${padId}`;
    return new Promise((resolve) => {
      try {
        if (!db.objectStoreNames.contains(DB_STORE)) {
          resolve(null);
          return;
        }
        const tx = db.transaction(DB_STORE, 'readonly');
        const store = tx.objectStore(DB_STORE);
        const req = store.get(slotKey);
        req.onsuccess = () => {
          if (req.result) {
            resolve(req.result);
            return;
          }
          const legacyReq = store.get(legacyKey);
          legacyReq.onsuccess = () => resolve(legacyReq.result || null);
          legacyReq.onerror = () => resolve(null);
        };
        req.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
  }

  async function loadAudioFromIndexedDB(paletteId, padId) {
    const db = await openAudioDatabase();
    const primaryRec = await getRecordFromDBInstance(db, paletteId, padId);
    if (primaryRec) return primaryRec;

    for (const legacyDbName of LEGACY_DB_NAMES) {
      try {
        const legacyDb = await openSingleDB(legacyDbName);
        const legacyRec = await getRecordFromDBInstance(legacyDb, paletteId, padId);
        legacyDb.close();
        if (legacyRec) return legacyRec;
      } catch (_) {}
    }
    return null;
  }

  async function deletePadAudioFromIndexedDB(paletteId, padId) {
    try {
      const db = await openAudioDatabase();
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      store.delete(getPaletteSlotKey(paletteId, padId));
      store.delete(`${paletteId}::${padId}`);
    } catch (err) {
      console.warn('No se pudo eliminar el audio del botón en IndexedDB:', err);
    }
  }

  async function deletePaletteAudiosFromIndexedDB(paletteId) {
    try {
      const db = await openAudioDatabase();
      const allPadIds = [...LEFT_KEYS.map((k) => `L-${k}`), ...RIGHT_KEYS.map((k) => `R-${k}`)];
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      allPadIds.forEach((padId) => {
        const slotKey = getPaletteSlotKey(paletteId, padId);
        delete appState.decodedAudioCache[slotKey];
        delete appState.rawAudioCache[slotKey];
        delete appState.waveformPeaksCache[slotKey];
        if (appState.audioBlobUrlCache[slotKey]) {
          URL.revokeObjectURL(appState.audioBlobUrlCache[slotKey]);
          delete appState.audioBlobUrlCache[slotKey];
        }
        store.delete(slotKey);
        store.delete(`${paletteId}::${padId}`);
      });
    } catch (err) {
      console.warn('No se pudieron limpiar audios de la paleta borrada:', err);
    }
  }

  // =========================================================================
  // MOTOR DE AUDIO WEB AUDIO API + LIMITADOR EN dB + VÚMETRO MASTER
  // =========================================================================
  function getDecodeAudioContext() {
    if (!appState.decodeCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      appState.decodeCtx = new AudioCtx();
    }
    return appState.decodeCtx;
  }

  async function decodeAudioFileBuffer(arrayBuffer) {
    const ctx = getDecodeAudioContext();
    const copyBuffer = arrayBuffer.slice(0);
    return await ctx.decodeAudioData(copyBuffer);
  }

  function computeWaveformPeaks(slotKey, audioBuffer, numBars = 140) {
    if (appState.waveformPeaksCache[slotKey]) {
      return appState.waveformPeaksCache[slotKey];
    }
    if (!audioBuffer) return null;

    const channelData = audioBuffer.getChannelData(0);
    const totalSamples = channelData.length;
    const blockSize = Math.max(1, Math.floor(totalSamples / numBars));
    const peaks = new Float32Array(numBars);
    let maxPeak = 0.001;

    for (let i = 0; i < numBars; i++) {
      const start = i * blockSize;
      const end = Math.min(totalSamples, start + blockSize);
      let peak = 0;
      const step = Math.max(1, Math.floor((end - start) / 40));
      for (let j = start; j < end; j += step) {
        const absVal = Math.abs(channelData[j]);
        if (absVal > peak) peak = absVal;
      }
      peaks[i] = peak;
      if (peak > maxPeak) maxPeak = peak;
    }

    for (let i = 0; i < numBars; i++) {
      peaks[i] = clamp(peaks[i] / maxPeak, 0.06, 1.0);
    }

    appState.waveformPeaksCache[slotKey] = peaks;
    return peaks;
  }

  function createOrRefreshAudioBlobUrl(slotKey, arrayBuffer, fileName = '', forceNew = false) {
    if (!forceNew && appState.audioBlobUrlCache[slotKey]) {
      return appState.audioBlobUrlCache[slotKey];
    }
    if (appState.audioBlobUrlCache[slotKey]) {
      try {
        URL.revokeObjectURL(appState.audioBlobUrlCache[slotKey]);
      } catch (_) {}
      delete appState.audioBlobUrlCache[slotKey];
    }
    if (!arrayBuffer) return '';
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    const mimeMap = {
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      oga: 'audio/ogg',
      m4a: 'audio/mp4',
      aac: 'audio/aac',
      flac: 'audio/flac',
      webm: 'audio/webm'
    };
    const mime = mimeMap[ext] || 'audio/mpeg';
    const blob = new Blob([arrayBuffer.slice(0)], { type: mime });
    const url = URL.createObjectURL(blob);
    appState.audioBlobUrlCache[slotKey] = url;
    return url;
  }

  function applyPreservePitchToMediaElement(audioEl, enabled) {
    if (!audioEl) return;
    const flag = Boolean(enabled);
    try {
      if ('preservesPitch' in audioEl) audioEl.preservesPitch = flag;
      if ('mozPreservesPitch' in audioEl) audioEl.mozPreservesPitch = flag;
      if ('webkitPreservesPitch' in audioEl) audioEl.webkitPreservesPitch = flag;
    } catch (_) {}
  }

  function isSideLimiterEnabled(bank) {
    if (typeof appState.limiter.enabled === 'boolean' && appState.limiter.enabled === false) {
      return false;
    }
    return bank === 'R'
      ? Boolean(appState.limiter.enabledR !== false)
      : Boolean(appState.limiter.enabledL !== false);
  }

  function getSideLimiterDb(bank) {
    const raw = bank === 'R'
      ? (appState.limiter.thresholdDbR ?? appState.limiter.thresholdDb)
      : (appState.limiter.thresholdDbL ?? appState.limiter.thresholdDb);
    return clamp(Number(raw ?? DEFAULT_LIMITER_DB), MIN_LIMITER_DB, MAX_LIMITER_DB);
  }

  function isBankChannelAssigned(bank) {
    const cfg = appState.routing[bank];
    if (!cfg) return false;
    const mode = cfg.channelMode || (bank === 'L' ? 'ch1' : 'ch2');
    return Boolean((cfg.deviceId && cfg.deviceId.trim() !== '') || mode !== 'ch1_ch2');
  }

  function getBankMeterMode(bank) {
    return isBankChannelAssigned(bank) ? 'mono' : 'stereo';
  }

  function buildLimiterCeilingCurve(thresholdDb, enabled) {
    const samples = 2048;
    const curve = new Float32Array(samples);
    const ceiling = enabled ? Math.pow(10, clamp(thresholdDb, -48, 0) / 20) : 1.0;

    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / (samples - 1) - 1;
      if (!enabled) {
        curve[i] = x;
      } else if (x > ceiling) {
        curve[i] = ceiling;
      } else if (x < -ceiling) {
        curve[i] = -ceiling;
      } else {
        curve[i] = x;
      }
    }
    return curve;
  }

  function applyLimiterParametersToEngine(engine) {
    if (!engine || !engine.ctx || !engine.limiterNode) return;
    const bank = engine.bank === 'R' ? 'R' : 'L';
    const now = engine.ctx.currentTime;
    const enabled = isSideLimiterEnabled(bank);
    const threshDb = getSideLimiterDb(bank);

    try {
      if (enabled) {
        engine.limiterNode.threshold.setValueAtTime(threshDb, now);
        engine.limiterNode.knee.setValueAtTime(0, now);
        engine.limiterNode.ratio.setValueAtTime(40, now);
        engine.limiterNode.attack.setValueAtTime(0.001, now);
        engine.limiterNode.release.setValueAtTime(0.04, now);
      } else {
        engine.limiterNode.threshold.setValueAtTime(0, now);
        engine.limiterNode.knee.setValueAtTime(0, now);
        engine.limiterNode.ratio.setValueAtTime(1, now);
      }
      if (engine.ceilingShaper) {
        engine.ceilingShaper.curve = buildLimiterCeilingCurve(threshDb, enabled);
        engine.ceilingShaper.oversample = enabled ? '4x' : 'none';
      }
    } catch (_) {}
  }

  function rebuildEngineMasterChain(engine) {
    if (!engine || !engine.ctx) return;
    const ctx = engine.ctx;

    try {
      if (engine.masterBusGain) engine.masterBusGain.disconnect();
      if (engine.limiterNode) engine.limiterNode.disconnect();
      if (engine.ceilingShaper) engine.ceilingShaper.disconnect();
      if (engine.masterAnalyser) engine.masterAnalyser.disconnect();
    } catch (_) {}

    engine.masterBusGain = ctx.createGain();
    engine.masterBusGain.gain.value = 1.0;

    engine.limiterNode = ctx.createDynamicsCompressor();
    engine.ceilingShaper = ctx.createWaveShaper();
    applyLimiterParametersToEngine(engine);

    engine.masterAnalyser = ctx.createAnalyser();
    engine.masterAnalyser.fftSize = 256;
    engine.masterAnalyser.smoothingTimeConstant = 0.72;
    engine.masterDataArray = new Uint8Array(engine.masterAnalyser.frequencyBinCount);

    const maxCh = clamp(ctx.destination.maxChannelCount || engine.maxChannels || 2, 1, 8);
    const modeInfo = parseChannelMode(engine.channelMode, maxCh);

    const targetDestination =
      engine.fallbackSinkApplied && engine.fallbackStreamDest
        ? engine.fallbackStreamDest
        : ctx.destination;

    const outChannels =
      engine.fallbackSinkApplied && engine.fallbackStreamDest
        ? clamp(
            engine.fallbackStreamDest.stream.getAudioTracks()[0]?.getSettings?.().channelCount || maxCh,
            1,
            8
          )
        : maxCh;

    const actualChannels = clamp(Math.max(outChannels, modeInfo.chA + 1, modeInfo.chB + 1), 1, 8);
    const merger = ctx.createChannelMerger(actualChannels);
    const splitter = ctx.createChannelSplitter(2);

    engine.masterBusGain.connect(engine.limiterNode);
    engine.limiterNode.connect(engine.ceilingShaper);
    engine.ceilingShaper.connect(engine.masterAnalyser);
    engine.masterAnalyser.connect(splitter);

    if (modeInfo.type === 'stereo') {
      splitter.connect(merger, 0, modeInfo.chA);
      splitter.connect(merger, 1, modeInfo.chB);
    } else {
      const monoSumGain = ctx.createGain();
      monoSumGain.gain.value = 0.5;
      splitter.connect(monoSumGain, 0);
      splitter.connect(monoSumGain, 1);
      monoSumGain.connect(merger, 0, modeInfo.chA);
    }

    merger.connect(targetDestination);
  }

  function populateChannelSelectOptions(selectEl, maxChannels, selectedMode) {
    if (!selectEl) return;
    const safeMax = clamp(maxChannels || 2, 1, 8);
    const options = [
      { value: 'ch1', label: 'Canal 1 (Mono)' },
      { value: 'ch2', label: 'Canal 2 (Mono)' },
      { value: 'ch1_ch2', label: 'Canales 1 + 2 (Estéreo)' }
    ];
    for (let ch = 3; ch <= safeMax; ch++) {
      options.push({ value: `ch${ch}`, label: `Canal ${ch} (Mono)` });
    }
    selectEl.innerHTML = '';
    options.forEach((opt) => {
      const el = document.createElement('option');
      el.value = opt.value;
      el.textContent = opt.label;
      selectEl.appendChild(el);
    });
    const validValues = new Set(options.map((o) => o.value));
    selectEl.value = validValues.has(selectedMode) ? selectedMode : 'ch1';
  }

  function parseChannelMode(mode, maxChannels) {
    const safeMax = clamp(maxChannels || 2, 1, 8);
    if (mode === 'ch1_ch2') {
      return {
        type: 'stereo',
        chA: clamp(0, 0, safeMax - 1),
        chB: clamp(1, 0, safeMax - 1)
      };
    }
    const match = /^ch(\d+)$/i.exec(mode || '');
    const chIndex = match ? clamp(parseInt(match[1], 10) - 1, 0, safeMax - 1) : 0;
    return {
      type: 'mono',
      chA: chIndex,
      chB: chIndex
    };
  }

  async function bindSinkDeviceToEngine(engine, targetDeviceId) {
    const ctx = engine.ctx;
    if (!ctx) return;

    const cleanId = targetDeviceId || '';
    engine.fallbackSinkApplied = false;

    if (typeof ctx.setSinkId === 'function') {
      try {
        await ctx.setSinkId(cleanId);
        engine.sinkDeviceId = cleanId;
        return;
      } catch (err) {
        console.warn(`AudioContext.setSinkId falló en banco ${engine.bank}:`, err);
      }
    }

    try {
      if (!engine.fallbackStreamDest) {
        engine.fallbackStreamDest = ctx.createMediaStreamDestination();
      }
      if (!engine.fallbackAudioEl) {
        const audioEl = document.createElement('audio');
        audioEl.autoplay = true;
        audioEl.srcObject = engine.fallbackStreamDest.stream;
        engine.fallbackAudioEl = audioEl;
      } else if (engine.fallbackAudioEl.srcObject !== engine.fallbackStreamDest.stream) {
        engine.fallbackAudioEl.srcObject = engine.fallbackStreamDest.stream;
      }

      if (typeof engine.fallbackAudioEl.setSinkId === 'function') {
        await engine.fallbackAudioEl.setSinkId(cleanId);
        engine.fallbackSinkApplied = true;
        engine.sinkDeviceId = cleanId;
        return;
      }
    } catch (err) {
      console.warn(`Respaldo HTMLAudioElement.setSinkId falló en banco ${engine.bank}:`, err);
    }

    engine.sinkDeviceId = cleanId;
  }

  async function ensureBankEngineReady(bank) {
    const engine = appState.engines[bank];
    const routeCfg = appState.routing[bank];
    if (!engine || !routeCfg) return null;

    let needsRebuild = false;

    if (!engine.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      engine.ctx = new AudioCtx();
      needsRebuild = true;
    }

    if (engine.ctx.state === 'suspended') {
      try {
        await engine.ctx.resume();
      } catch (_) {}
    }

    engine.maxChannels = clamp(engine.ctx.destination.maxChannelCount || 2, 1, 8);
    const desiredMode = routeCfg.channelMode || (bank === 'L' ? 'ch1' : 'ch2');
    if (engine.channelMode !== desiredMode) {
      engine.channelMode = desiredMode;
      needsRebuild = true;
    }

    const desiredSink = routeCfg.deviceId || '';
    if (engine.sinkDeviceId !== desiredSink) {
      await bindSinkDeviceToEngine(engine, desiredSink);
      needsRebuild = true;
    }

    if (needsRebuild || !engine.masterBusGain) {
      rebuildEngineMasterChain(engine);
    }

    return engine;
  }

  function connectNodeToBankOutput(engine, sourceGainNode) {
    if (!engine.masterBusGain) {
      rebuildEngineMasterChain(engine);
    }
    sourceGainNode.connect(engine.masterBusGain);
  }

  async function playTestTone(bank) {
    try {
      const engine = await ensureBankEngineReady(bank);
      if (!engine || !engine.ctx) return;

      const ctx = engine.ctx;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const env = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(bank === 'L' ? 440 : 660, now);

      env.gain.setValueAtTime(0.0001, now);
      env.gain.exponentialRampToValueAtTime(0.28, now + 0.02);
      env.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);

      osc.connect(env);
      connectNodeToBankOutput(engine, env);

      osc.start(now);
      osc.stop(now + 0.36);
      showToast(`Tono de prueba enviado al Banco ${bank} (${engine.channelMode.toUpperCase()}).`, 'info');
    } catch (err) {
      console.warn('Error al reproducir tono de prueba:', err);
      showToast('No se pudo emitir el tono de prueba.', 'warning');
    }
  }

  // =========================================================================
  // VÚMETRO CENTRAL SEPARADO (L | R) Y LIMITADOR CONFIGURABLE (-9 dB)
  // =========================================================================
  function startMasterVuLoop() {
    if (appState.masterVuRafId) return;

    const computeMeterDbFromEngine = (bank, forceMono = false) => {
      const engine = appState.engines[bank];
      const hasPlaying =
        appState.activePlaybacks.some((pb) => pb.channel === bank) ||
        appState.fadingPlaybacks.some((pb) => pb.channel === bank);

      if (!engine || !engine.masterAnalyser || !engine.masterDataArray || !hasPlaying) {
        return -60;
      }

      engine.masterAnalyser.getByteTimeDomainData(engine.masterDataArray);
      let peakSample = 0;
      let sumSq = 0;
      const len = engine.masterDataArray.length;

      for (let i = 0; i < len; i++) {
        const norm = Math.abs((engine.masterDataArray[i] - 128) / 128);
        if (norm > peakSample) peakSample = norm;
        sumSq += norm * norm;
      }

      const effectiveLevel = forceMono ? Math.max(peakSample, Math.sqrt(sumSq / len) * 1.45) : peakSample;
      if (effectiveLevel > 0.0008) {
        return clamp(20 * Math.log10(effectiveLevel), -60, 0);
      }
      return -60;
    };

    const drawSideCanvas = (bank, db) => {
      const canvas = document.getElementById(`masterVuCanvas-${bank}`);
      const dbTextEl = document.getElementById(`masterDbReadout-${bank}`);
      if (!canvas) return;

      const ctx2d = canvas.getContext('2d');
      const w = canvas.width;
      const h = canvas.height;
      ctx2d.clearRect(0, 0, w, h);

      const normLevel = clamp((db + 60) / 60, 0, 1);
      if (normLevel >= appState.masterVuPeakHold[bank]) {
        appState.masterVuPeakHold[bank] = normLevel;
      } else {
        appState.masterVuPeakHold[bank] = Math.max(normLevel, appState.masterVuPeakHold[bank] - 0.008);
      }

      const fillHeight = Math.round(normLevel * h);
      const grad = ctx2d.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0.0, '#16a34a');
      grad.addColorStop(0.65, '#84cc16');
      grad.addColorStop(0.85, '#facc15');
      grad.addColorStop(0.95, '#f97316');
      grad.addColorStop(1.0, '#ef4444');

      ctx2d.fillStyle = grad;
      ctx2d.fillRect(0, h - fillHeight, w, fillHeight);

      const peakY = h - Math.round(appState.masterVuPeakHold[bank] * h);
      if (appState.masterVuPeakHold[bank] > 0.02) {
        ctx2d.fillStyle = '#ffffff';
        ctx2d.fillRect(0, clamp(peakY, 0, h - 2), w, 2);
      }

      if (dbTextEl) {
        const suffix = getBankMeterMode(bank) === 'mono' ? ' M' : '';
        dbTextEl.textContent = db <= -59 ? `-∞ dB${suffix}` : `${db.toFixed(1)} dB${suffix}`;
      }
    };

    const tick = () => {
      const modeL = getBankMeterMode('L');
      const modeR = getBankMeterMode('R');

      const dbL = computeMeterDbFromEngine('L', modeL === 'mono');
      const dbR = computeMeterDbFromEngine('R', modeR === 'mono');
      drawSideCanvas('L', dbL);
      drawSideCanvas('R', dbR);

      const clockEl = document.getElementById('masterClockReadout');
      if (clockEl) {
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        clockEl.textContent = `${hh}:${mm}:${ss}`;
      }

      appState.masterVuRafId = requestAnimationFrame(tick);
    };

    appState.masterVuRafId = requestAnimationFrame(tick);
  }

  function renderLimiterUI() {
    const enabledL = isSideLimiterEnabled('L');
    const enabledR = isSideLimiterEnabled('R');
    const dbL = getSideLimiterDb('L');
    const dbR = getSideLimiterDb('R');
    const dbVal = clamp(Number(appState.limiter.thresholdDb ?? dbL), MIN_LIMITER_DB, MAX_LIMITER_DB);

    const modeL = getBankMeterMode('L');
    const modeR = getBankMeterMode('R');

    const headerTitle = document.getElementById('vuHeaderTitle');
    const headerSubtitle = document.getElementById('vuHeaderSubtitle');
    const badgeModeL = document.getElementById('meterModeBadge-L');
    const badgeModeR = document.getElementById('meterModeBadge-R');
    const limSideBadgeL = document.getElementById('limiterSideBadge-L');
    const limSideBadgeR = document.getElementById('limiterSideBadge-R');

    if (headerTitle && headerSubtitle) {
      if (modeL === 'stereo' && modeR === 'stereo') {
        headerTitle.textContent = 'Vúmetro Master';
        headerSubtitle.textContent = 'Estéreo L / R + Limitadores';
      } else if (modeL === 'mono' && modeR === 'mono') {
        headerTitle.textContent = 'Vúmetros Canal';
        headerSubtitle.textContent = 'Mono L + Mono R (Limitador/lado)';
      } else {
        headerTitle.textContent = 'Vúmetros Mixtos';
        headerSubtitle.textContent = `L: ${modeL.toUpperCase()} · R: ${modeR.toUpperCase()}`;
      }
    }

    const chLabelL = (appState.routing.L.channelMode || 'ch1').toUpperCase();
    const chLabelR = (appState.routing.R.channelMode || 'ch2').toUpperCase();

    if (badgeModeL) {
      badgeModeL.textContent = modeL === 'mono' ? chLabelL : 'RL';
      badgeModeL.className =
        modeL === 'mono'
          ? 'meter-mode-pill bg-amber-500/20 text-amber-200 border border-amber-400/40'
          : 'meter-mode-pill bg-sky-500/20 text-sky-200 border border-sky-400/35';
    }

    if (badgeModeR) {
      badgeModeR.textContent = modeR === 'mono' ? chLabelR : 'RL';
      badgeModeR.className =
        modeR === 'mono'
          ? 'meter-mode-pill bg-amber-500/20 text-amber-200 border border-amber-400/40'
          : 'meter-mode-pill bg-indigo-500/20 text-indigo-200 border border-indigo-400/35';
    }

    const cbL = document.getElementById('limiterEnabledCheckbox-L');
    const cbR = document.getElementById('limiterEnabledCheckbox-R');
    const labelDb = document.getElementById('limiterLabelDbValue');
    const slider = document.getElementById('limiterThresholdSlider');
    const numInput = document.getElementById('limiterThresholdNumber');
    const badge = document.getElementById('limiterReductionBadge');
    const lineL = document.getElementById('limiterLine-L');
    const lineR = document.getElementById('limiterLine-R');

    if (cbL) cbL.checked = enabledL;
    if (cbR) cbR.checked = enabledR;
    if (labelDb) labelDb.textContent = `${dbVal} dB`;
    if (slider) slider.value = String(dbVal);
    if (numInput) numInput.value = String(dbVal);

    const bottomPctL = clamp(((dbL + 60) / 60) * 100, 0, 100);
    const bottomPctR = clamp(((dbR + 60) / 60) * 100, 0, 100);

    if (lineL) {
      lineL.style.bottom = `${bottomPctL.toFixed(1)}%`;
      lineL.style.opacity = enabledL ? '1' : '0.2';
    }
    if (lineR) {
      lineR.style.bottom = `${bottomPctR.toFixed(1)}%`;
      lineR.style.opacity = enabledR ? '1' : '0.2';
    }

    if (limSideBadgeL) {
      limSideBadgeL.textContent = enabledL ? `LIM ${dbL}dB` : 'LIM OFF';
      limSideBadgeL.className = enabledL
        ? 'font-mono text-[9px] text-sky-300 font-bold'
        : 'font-mono text-[9px] text-slate-500';
    }
    if (limSideBadgeR) {
      limSideBadgeR.textContent = enabledR ? `LIM ${dbR}dB` : 'LIM OFF';
      limSideBadgeR.className = enabledR
        ? 'font-mono text-[9px] text-indigo-300 font-bold'
        : 'font-mono text-[9px] text-slate-500';
    }

    if (badge) {
      if (enabledL || enabledR) {
        badge.textContent = `L:${enabledL ? dbL.toFixed(1) + 'dB' : 'OFF'} · R:${enabledR ? dbR.toFixed(1) + 'dB' : 'OFF'}`;
        badge.className =
          'text-center font-mono text-[10px] text-emerald-300 bg-slate-900/90 rounded py-0.5 border border-emerald-500/35';
      } else {
        badge.textContent = 'LIMITADORES L/R OFF';
        badge.className =
          'text-center font-mono text-[10px] text-slate-400 bg-slate-900/90 rounded py-0.5 border border-slate-800';
      }
    }

    applyLimiterParametersToEngine(appState.engines.L);
    applyLimiterParametersToEngine(appState.engines.R);
  }

  // =========================================================================
  // EXCLUSIVIDAD, FADE INTERACTIVO (SHIFT+TECLA) Y MODOS NORMAL/SINGLE/SAMPLER
  // =========================================================================
  function getActivePlaybacksForPad(pad) {
    if (!pad) return [];
    const fromPad = Array.isArray(pad.activeSources) ? pad.activeSources : [];
    const fromGlobal = appState.activePlaybacks.filter(
      (pb) => pb.padRef === pad || (pb.paletteId === pad.paletteId && pb.padId === pad.id)
    );
    const merged = [];
    const seen = new Set();
    [...fromPad, ...fromGlobal].forEach((pb) => {
      if (pb && !seen.has(pb)) {
        seen.add(pb);
        merged.push(pb);
      }
    });
    return merged;
  }

  function syncPadActiveFlag(pad) {
    if (!pad) return;
    const activeList = appState.activePlaybacks.filter(
      (pb) => pb.padRef === pad || (pb.paletteId === pad.paletteId && pb.padId === pad.id)
    );
    pad.activeSources = activeList;
    if (!activeList.length) {
      stopProgressLoop(pad, true);
    }
    if (appState.pads[pad.id] === pad) {
      renderPadVisuals(pad);
    }
    updateBankMasterProgressBar(pad.channel);
  }

  function getAllActivePadsAcrossPalettes() {
    const list = [];
    const seen = new Set();
    appState.activePlaybacks.forEach((pb) => {
      if (pb && pb.padRef && !seen.has(pb.padRef)) {
        seen.add(pb.padRef);
        list.push(pb.padRef);
      }
    });
    Object.values(appState.pads).forEach((p) => {
      if (p && !seen.has(p)) {
        seen.add(p);
        list.push(p);
      }
    });
    Object.values(appState.palettePadsCache).forEach((palMap) => {
      if (!palMap) return;
      Object.values(palMap).forEach((p) => {
        if (p && !seen.has(p)) {
          seen.add(p);
          list.push(p);
        }
      });
    });
    return list;
  }

  function getPaletteFadeMsForBank(bank) {
    const pal = getBankPalette(bank);
    return pal ? clamp(Math.round(Number(pal.fadeMs) || 0), MIN_FADE_MS, MAX_FADE_MS) : 0;
  }

  function getEffectiveFadeInSeconds(skipFadeIn = false, bank = null) {
    if (skipFadeIn) return 0;
    const palFadeMs = bank ? getPaletteFadeMsForBank(bank) : 0;
    if (palFadeMs > 0) return palFadeMs / 1000;
    if (appState.transition.mode !== 'fade') return 0;
    return clamp(Number(appState.transition.fadeInMs) || 0, MIN_FADE_MS, MAX_FADE_MS) / 1000;
  }

  function getEffectiveFadeOutSeconds(forceInstant = false, bank = null) {
    if (forceInstant) return 0;
    const palFadeMs = bank ? getPaletteFadeMsForBank(bank) : 0;
    if (palFadeMs > 0) return palFadeMs / 1000;
    if (appState.transition.mode !== 'fade') return 0;
    return clamp(Number(appState.transition.fadeOutMs) || 0, MIN_FADE_MS, MAX_FADE_MS) / 1000;
  }

  function cleanupAudioEntryNodes(entry) {
    if (!entry) return;
    if (entry.fadeOutTimer) {
      clearTimeout(entry.fadeOutTimer);
      entry.fadeOutTimer = null;
    }
    if (entry.fadeOutRafId) {
      cancelAnimationFrame(entry.fadeOutRafId);
      entry.fadeOutRafId = null;
    }
    appState.activePlaybacks = appState.activePlaybacks.filter((item) => item !== entry);
    appState.fadingPlaybacks = appState.fadingPlaybacks.filter((item) => item !== entry);
    try {
      if (entry.mediaEl) {
        entry.mediaEl.onended = null;
        entry.mediaEl.pause();
        entry.mediaEl.src = '';
        entry.mediaEl.load();
      }
    } catch (_) {}
    try {
      if (entry.source) {
        entry.source.onended = null;
        if (typeof entry.source.stop === 'function') entry.source.stop();
        entry.source.disconnect();
      }
      if (entry.gain) entry.gain.disconnect();
      if (entry.analyser) entry.analyser.disconnect();
    } catch (_) {}
  }

  function stopPlaybackEntry(entry, forceInstant = false, customFadeOutSeconds = null) {
    if (!entry) return;
    const wasActive = appState.activePlaybacks.includes(entry);
    appState.activePlaybacks = appState.activePlaybacks.filter((item) => item !== entry);

    const targetPad = entry.padRef || appState.pads[entry.padId] || null;
    if (targetPad && Array.isArray(targetPad.activeSources)) {
      targetPad.activeSources = targetPad.activeSources.filter((item) => item !== entry);
    }

    const fadeOutSec =
      typeof customFadeOutSeconds === 'number' && customFadeOutSeconds > 0
        ? customFadeOutSeconds
        : wasActive
          ? getEffectiveFadeOutSeconds(forceInstant, entry.channel)
          : 0;
    const engine = appState.engines[entry.channel];

    if (!forceInstant && (wasActive || customFadeOutSeconds) && fadeOutSec > 0.005 && engine && engine.ctx) {
      const ctx = engine.ctx;
      const now = ctx.currentTime;
      const fallbackGain = targetPad ? targetPad.volume : 0.5;
      const currentGain = Math.max(0.0001, entry.gain.gain.value || fallbackGain || 0.0001);

      try {
        entry.gain.gain.cancelScheduledValues(now);
        entry.gain.gain.setValueAtTime(currentGain, now);
        entry.gain.gain.linearRampToValueAtTime(0.0001, now + fadeOutSec);
      } catch (_) {}

      if (entry.mediaEl) {
        const startVol = clamp(entry.mediaEl.volume, 0, 1);
        const fadeStartPerf = performance.now();
        const stepMediaFade = () => {
          const elapsedSec = (performance.now() - fadeStartPerf) / 1000;
          const ratio = clamp(1 - elapsedSec / fadeOutSec, 0, 1);
          entry.mediaEl.volume = startVol * ratio;
          if (ratio > 0.01 && appState.fadingPlaybacks.includes(entry)) {
            entry.fadeOutRafId = requestAnimationFrame(stepMediaFade);
          }
        };
        entry.fadeOutRafId = requestAnimationFrame(stepMediaFade);
      }

      if (!appState.fadingPlaybacks.includes(entry)) {
        appState.fadingPlaybacks.push(entry);
      }
      if (targetPad) {
        if (!Array.isArray(targetPad.fadingOutSources)) {
          targetPad.fadingOutSources = [];
        }
        if (!targetPad.fadingOutSources.includes(entry)) {
          targetPad.fadingOutSources.push(entry);
        }
      }

      const handleEnded = () => {
        if (targetPad && Array.isArray(targetPad.fadingOutSources)) {
          targetPad.fadingOutSources = targetPad.fadingOutSources.filter((item) => item !== entry);
        }
        cleanupAudioEntryNodes(entry);
      };

      if (entry.mediaEl) {
        entry.mediaEl.onended = handleEnded;
      } else if (entry.source) {
        entry.source.onended = handleEnded;
      }

      entry.fadeOutTimer = setTimeout(() => {
        if (targetPad && Array.isArray(targetPad.fadingOutSources)) {
          targetPad.fadingOutSources = targetPad.fadingOutSources.filter((item) => item !== entry);
        }
        cleanupAudioEntryNodes(entry);
      }, Math.ceil(fadeOutSec * 1000) + 60);
    } else {
      if (targetPad && Array.isArray(targetPad.fadingOutSources)) {
        targetPad.fadingOutSources = targetPad.fadingOutSources.filter((item) => item !== entry);
      }
      cleanupAudioEntryNodes(entry);
    }

    if (targetPad) {
      syncPadActiveFlag(targetPad);
    }
    updateBankMasterProgressBar(entry.channel);
  }

  function stopPadInstance(pad, forceInstant = false, customFadeOutSeconds = null) {
    if (!pad) return;

    if (!pad.fadingOutSources) {
      pad.fadingOutSources = [];
    }

    if (forceInstant && pad.fadingOutSources.length > 0) {
      pad.fadingOutSources.forEach((entry) => cleanupAudioEntryNodes(entry));
      pad.fadingOutSources = [];
    }

    const activeEntries = getActivePlaybacksForPad(pad);
    pad.activeSources = [];
    if (activeEntries.length > 0) {
      activeEntries.forEach((entry) => stopPlaybackEntry(entry, forceInstant, customFadeOutSeconds));
    }

    stopProgressLoop(pad, true);
    if (appState.pads[pad.id] === pad) {
      renderPadVisuals(pad);
    }
    updateBankMasterProgressBar(pad.channel);
  }

  // Fade Interactivo (Shift + Tecla del jingle): baja progresivamente hasta silencio (-∞ dB) y luego hace Stop
  function triggerInteractiveFadeStop(padId) {
    const pad = appState.pads[padId];
    if (!pad) return;

    const fadeMs = clamp(
      Math.round(Number(appState.transition.interactiveFadeMs) || DEFAULT_INTERACTIVE_FADE_MS),
      50,
      15000
    );
    const activeEntries = getActivePlaybacksForPad(pad);
    if (!activeEntries.length) {
      showToast(`${pad.label} no está sonando para aplicar Fade Interactivo.`, 'info');
      return;
    }

    stopPadInstance(pad, false, fadeMs / 1000);
    showToast(`Fade Interactivo (${fadeMs} ms → silencio + Stop) en ${pad.label}.`, 'info');
  }

  function enforceExclusiveChannelAndColor(triggerPadObj) {
    const normalizedTargetColor = String(triggerPadObj.color || '').trim().toLowerCase();
    const hasTargetColor = Boolean(normalizedTargetColor);
    const targetChannel = triggerPadObj.channel;

    const matchingPlaybacks = appState.activePlaybacks.filter((pb) => {
      const isSamePad =
        pb.padRef === triggerPadObj ||
        (pb.paletteId === triggerPadObj.paletteId && pb.padId === triggerPadObj.id);
      const isSameSide = pb.channel === targetChannel;
      const pbColor = String(pb.color || (pb.padRef && pb.padRef.color) || '')
        .trim()
        .toLowerCase();
      const isSameColor = hasTargetColor && pbColor === normalizedTargetColor;
      return isSamePad || isSameSide || isSameColor;
    });

    matchingPlaybacks.forEach((pb) => {
      stopPlaybackEntry(pb, false);
    });
  }

  async function triggerPad(
    padId,
    customStartSeconds = null,
    skipExclusivity = false,
    skipFadeIn = false
  ) {
    const pad = appState.pads[padId];
    if (!pad) return;

    const mode = normalizeTriggerMode(pad.triggerMode);

    // MODO SINGLE: si ya está sonando y no se pidió un salto explícito de CUE/Seek, al volver a tocarlo se detiene
    if (mode === 'single' && customStartSeconds === null && !skipExclusivity) {
      const alreadyPlaying = getActivePlaybacksForPad(pad);
      if (alreadyPlaying.length > 0) {
        stopPadInstance(pad, false);
        showToast(`Single Stop: ${pad.label}`, 'info');
        return;
      }
    }

    const bank = pad.channel;
    const sourcePalette = getBankPalette(bank);
    if (!sourcePalette) return;

    const sourcePaletteId = sourcePalette.id;
    const slotKey = getPaletteSlotKey(sourcePaletteId, pad.id);
    const sharedKey = getSharedSlotKey(sourcePaletteId, pad.id);
    const mirrorId = getMirrorPadId(pad.id);
    const mirrorKey = mirrorId ? getPaletteSlotKey(sourcePaletteId, mirrorId) : '';
    const resolvedBuffer =
      appState.decodedAudioCache[slotKey] ||
      appState.decodedAudioCache[sharedKey] ||
      (mirrorKey ? appState.decodedAudioCache[mirrorKey] : null) ||
      pad.audioBuffer;
    if (resolvedBuffer && pad.audioBuffer !== resolvedBuffer) {
      pad.audioBuffer = resolvedBuffer;
    }

    selectPad(pad.id);
    appState.lastTriggeredPadId = pad.id;

    if (!resolvedBuffer || pad.duration <= 0) {
      showToast(
        `${pad.channel} ${formatPadNumber(pad.number)} [${pad.key}] no tiene audio asignado en "${sourcePalette.name}" (clic derecho para cargar).`,
        'warning'
      );
      return;
    }

    if (!skipExclusivity) {
      enforceExclusiveChannelAndColor(pad);
    } else {
      const samePadActive = getActivePlaybacksForPad(pad);
      if (samePadActive.length > 0) {
        samePadActive.forEach((pb) => stopPlaybackEntry(pb, true));
      }
    }

    try {
      const engine = await ensureBankEngineReady(pad.channel);
      if (!engine || !engine.ctx) return;

      const ctx = engine.ctx;
      const totalDuration = resolvedBuffer.duration || pad.duration;
      const maxSafeOffset = Math.max(0, totalDuration - 0.02);
      const cueOffset = clamp(getPrimaryCueSeconds(pad), 0, maxSafeOffset);
      const startOffset =
        typeof customStartSeconds === 'number' && Number.isFinite(customStartSeconds)
          ? clamp(customStartSeconds, 0, maxSafeOffset)
          : cueOffset;

      const playbackRate = bpmToRate(pad.bpm || DEFAULT_BPM, pad.detectedBpm || DEFAULT_BPM);
      const isLoopEnabled = Boolean(pad.bucle);

      const targetVol = clamp(pad.volume, 0, 1);
      const startedAtCtxTime = ctx.currentTime;
      const fadeInSec = getEffectiveFadeInSeconds(skipFadeIn, bank);
      const remainingBufferSec = Math.max(0.02, totalDuration - startOffset);
      const effectiveFadeInSec = isLoopEnabled
        ? Math.min(fadeInSec, 0.25)
        : Math.min(fadeInSec, remainingBufferSec / Math.max(0.5, playbackRate));

      const gainNode = ctx.createGain();
      if (effectiveFadeInSec > 0.005 && targetVol > 0.0001) {
        gainNode.gain.setValueAtTime(0.0001, startedAtCtxTime);
        gainNode.gain.linearRampToValueAtTime(targetVol, startedAtCtxTime + effectiveFadeInSec);
      } else {
        gainNode.gain.setValueAtTime(targetVol, startedAtCtxTime);
      }

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      let sourceNode = null;
      let mediaEl = null;
      const blobUrl = appState.preservePitch
        ? createOrRefreshAudioBlobUrl(slotKey, appState.rawAudioCache[slotKey], pad.fileName, false)
        : '';

      if (appState.preservePitch && blobUrl) {
        mediaEl = new Audio(blobUrl);
        mediaEl.crossOrigin = 'anonymous';
        applyPreservePitchToMediaElement(mediaEl, true);
        mediaEl.playbackRate = playbackRate;
        mediaEl.loop = isLoopEnabled;
        mediaEl.volume = effectiveFadeInSec > 0.005 ? 0.01 : targetVol;
        try {
          mediaEl.currentTime = startOffset;
        } catch (_) {}

        sourceNode = ctx.createMediaElementSource(mediaEl);
        sourceNode.connect(gainNode);
        gainNode.connect(analyser);
        connectNodeToBankOutput(engine, gainNode);

        if (effectiveFadeInSec > 0.005 && targetVol > 0.0001) {
          const fadeStartMs = performance.now();
          const rampMediaIn = () => {
            if (!mediaEl || mediaEl.paused) return;
            const elapsedSec = (performance.now() - fadeStartMs) / 1000;
            const progress = clamp(elapsedSec / effectiveFadeInSec, 0, 1);
            mediaEl.volume = clamp(progress * targetVol, 0, 1);
            if (progress < 1) {
              requestAnimationFrame(rampMediaIn);
            }
          };
          requestAnimationFrame(rampMediaIn);
        }
      } else {
        const bufSrc = ctx.createBufferSource();
        bufSrc.buffer = resolvedBuffer;
        bufSrc.playbackRate.value = playbackRate;
        bufSrc.loop = isLoopEnabled;
        if (isLoopEnabled) {
          bufSrc.loopStart = cueOffset;
          bufSrc.loopEnd = totalDuration;
        }
        sourceNode = bufSrc;

        sourceNode.connect(gainNode);
        gainNode.connect(analyser);
        connectNodeToBankOutput(engine, gainNode);
      }

      const entry = {
        playKey: slotKey,
        paletteId: sourcePaletteId,
        padId: pad.id,
        btnId: pad.id,
        channel: pad.channel,
        color: String(pad.color || '').trim().toLowerCase(),
        padRef: pad,
        source: sourceNode,
        mediaEl,
        gain: gainNode,
        analyser,
        dataArray,
        startedAtCtxTime,
        startOffset,
        playbackRate,
        duration: totalDuration,
        fadeOutTimer: null,
        fadeOutRafId: null
      };

      appState.activePlaybacks.push(entry);
      if (!Array.isArray(pad.activeSources)) {
        pad.activeSources = [];
      }
      pad.activeSources.push(entry);

      renderPadVisuals(pad);
      startProgressLoop(pad);
      updateBankMasterProgressBar(pad.channel);

      const handleFinish = () => {
        pad.activeSources = pad.activeSources.filter((item) => item !== entry);
        cleanupAudioEntryNodes(entry);
        if (!pad.activeSources.length) {
          stopProgressLoop(pad, true);
          if (getBankPaletteId(pad.channel) === sourcePaletteId && appState.pads[pad.id] === pad) {
            renderPadVisuals(pad);
          }
        }
        updateBankMasterProgressBar(pad.channel);
      };

      if (mediaEl) {
        mediaEl.onended = handleFinish;
        mediaEl.addEventListener('seeked', () => {
          if (mediaEl.loop && mediaEl.currentTime < 0.05 && cueOffset > 0) {
            try {
              mediaEl.currentTime = cueOffset;
            } catch (_) {}
          }
        });
        await mediaEl.play();
      } else {
        sourceNode.onended = handleFinish;
        if (isLoopEnabled) {
          sourceNode.start(startedAtCtxTime, startOffset);
        } else {
          sourceNode.start(startedAtCtxTime, startOffset, remainingBufferSec);
        }
      }
    } catch (err) {
      console.error('Error al reproducir botón:', err);
      showToast('No se pudo reproducir el audio seleccionado.', 'error');
    }
  }

  function stopAllInChannel(channel) {
    let stoppedCount = 0;

    const channelPlaybacks = appState.activePlaybacks.filter((pb) => pb.channel === channel);
    channelPlaybacks.forEach((pb) => {
      stoppedCount++;
      stopPlaybackEntry(pb, false);
    });

    const channelFading = appState.fadingPlaybacks.filter((pb) => pb.channel === channel);
    channelFading.forEach((pb) => {
      cleanupAudioEntryNodes(pb);
    });

    getAllActivePadsAcrossPalettes().forEach((pad) => {
      if (pad.channel === channel && pad.activeSources && pad.activeSources.length > 0) {
        pad.activeSources.slice().forEach((pb) => {
          stoppedCount++;
          stopPlaybackEntry(pb, false);
        });
      }
    });

    updateBankMasterProgressBar(channel);

    const section = document.getElementById(`bankSection-${channel}`);
    if (section) {
      section.classList.remove('channel-stop-flash');
      void section.offsetWidth;
      section.classList.add('channel-stop-flash');
    }

    const labelSide = channel === 'L' ? 'Izquierdo (L)' : 'Derecho (R)';
    const fadeOutMs = getEffectiveFadeOutSeconds(false, channel) * 1000;
    showToast(
      stoppedCount > 0
        ? fadeOutMs > 0
          ? `Fade Out (${Math.round(fadeOutMs)} ms) aplicado a ${stoppedCount} audio(s) del Canal ${labelSide}.`
          : `Detenidos ${stoppedCount} audio(s) del Canal ${labelSide} y reseteados al CUE.`
        : `Canal ${labelSide} detenido y reseteado al CUE.`,
      'info'
    );
  }

  // Disparo rápido de CUE 1, 2 o 3 por teclado (Z/X/C para L · Num 1/2/3 para R)
  function triggerBankCueSlotByShortcut(bank, cueSlotIndex) {
    const playingPad = findPlayingPadInChannel(bank);
    const selectedPad = appState.pads[appState.selectedPadId];
    const fallbackBankPadId =
      selectedPad && selectedPad.channel === bank
        ? selectedPad.id
        : appState.lastSelectedByBank[bank] || (bank === 'L' ? 'L-1' : 'R-6');
    const targetPad = playingPad || appState.pads[fallbackBankPadId];
    if (!targetPad) return;

    const cues = normalizeCuesArray(targetPad.cues, targetPad.cueStart);
    const targetSec =
      typeof cues[cueSlotIndex] === 'number'
        ? cues[cueSlotIndex]
        : getPrimaryCueSeconds(targetPad);

    selectPad(targetPad.id);
    triggerPad(targetPad.id, targetSec, true, true);
    showToast(
      `${targetPad.channel} [${targetPad.key}] · CUE ${cueSlotIndex + 1} (${targetSec.toFixed(2)}s)`,
      'info'
    );
  }

  // =========================================================================
  // BARRA DE PROGRESO MAESTRA CON FORMA DE ONDA (WAVEFORM TIPO EDITOR)
  // =========================================================================
  function findPlayingPadInChannel(channel) {
    const globalForChannel = appState.activePlaybacks.filter((pb) => pb.channel === channel);
    if (globalForChannel.length > 0) {
      const selectedPb = globalForChannel.find((pb) => pb.padId === appState.selectedPadId);
      const chosen = selectedPb || globalForChannel[globalForChannel.length - 1];
      if (chosen.padRef) return chosen.padRef;
      if (appState.pads[chosen.padId]) return appState.pads[chosen.padId];
    }
    const inCurrent = Object.values(appState.pads).find(
      (p) => p.channel === channel && p.activeSources && p.activeSources.length > 0
    );
    if (inCurrent) return inCurrent;
    return (
      getAllActivePadsAcrossPalettes().find(
        (p) => p.channel === channel && p.activeSources && p.activeSources.length > 0
      ) || null
    );
  }

  function getCurrentEntryPositionSeconds(channel, entry) {
    if (!entry) return 0;
    if (entry.mediaEl && Number.isFinite(entry.mediaEl.currentTime)) {
      return clamp(entry.mediaEl.currentTime, 0, entry.duration || 0);
    }
    const engine = appState.engines[channel];
    if (!engine || !engine.ctx) return entry.startOffset;
    const elapsedCtx = Math.max(0, engine.ctx.currentTime - entry.startedAtCtxTime);
    const rate = entry.playbackRate || 1;
    const rawPos = entry.startOffset + elapsedCtx * rate;
    if (entry.source && entry.source.loop && entry.duration > 0) {
      const loopStart = clamp(entry.source.loopStart || 0, 0, entry.duration);
      const loopEnd = entry.source.loopEnd > loopStart ? entry.source.loopEnd : entry.duration;
      const span = Math.max(0.05, loopEnd - loopStart);
      if (rawPos >= loopEnd) {
        return loopStart + ((rawPos - loopStart) % span);
      }
    }
    return clamp(rawPos, 0, entry.duration || 0);
  }

  function drawBankWaveform(channel, progressFrac, playingPad) {
    const canvas = document.getElementById(`bankWaveformCanvas-${channel}`);
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const targetW = Math.max(240, Math.round(rect.width || 560));
    const targetH = Math.max(36, Math.round(rect.height || 44));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, targetW, targetH);

    const midY = targetH / 2;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(targetW, midY);
    ctx.stroke();

    const barCount = Math.max(70, Math.floor(targetW / 4));
    let peaks = null;

    if (playingPad && playingPad.audioBuffer) {
      const slotKey = getPaletteSlotKey(playingPad.paletteId || getBankPaletteId(channel), playingPad.id);
      peaks = computeWaveformPeaks(slotKey, playingPad.audioBuffer, barCount);
    }

    const barSlotW = targetW / barCount;
    const barW = Math.max(1.5, barSlotW * 0.65);

    for (let i = 0; i < barCount; i++) {
      const barFrac = i / barCount;
      const amp = peaks
        ? peaks[Math.min(peaks.length - 1, Math.floor(barFrac * peaks.length))]
        : 0.14 + 0.08 * Math.sin(i * 0.45);
      const barHalfH = Math.max(2, amp * (midY - 3));
      const x = i * barSlotW;

      if (playingPad) {
        if (barFrac <= progressFrac) {
          ctx.fillStyle = channel === 'L' ? '#34d399' : '#38bdf8';
        } else {
          ctx.fillStyle = 'rgba(148, 163, 184, 0.34)';
        }
      } else {
        ctx.fillStyle = 'rgba(71, 85, 105, 0.28)';
      }

      ctx.fillRect(x, midY - barHalfH, barW, barHalfH * 2);
    }

    if (playingPad && playingPad.duration > 0) {
      const cues = normalizeCuesArray(playingPad.cues, playingPad.cueStart);
      cues.forEach((cueSec, idx) => {
        if (typeof cueSec === 'number' && cueSec > 0) {
          const cueX = clamp((cueSec / playingPad.duration) * targetW, 1, targetW - 2);
          ctx.fillStyle = '#fbbf24';
          ctx.fillRect(cueX, 0, 1.5, targetH);
          ctx.font = 'bold 9px JetBrains Mono, monospace';
          ctx.fillText(`C${idx + 1}`, Math.min(targetW - 14, cueX + 2), 9);
        }
      });
    }
  }

  function updateBankMasterProgressBar(channel) {
    const barEl = document.getElementById(`bankMasterSeekBar-${channel}`);
    const playheadEl = document.getElementById(`bankMasterPlayhead-${channel}`);
    const titleEl = document.getElementById(`bankNowPlayingTitle-${channel}`);
    const timeEl = document.getElementById(`bankNowPlayingTime-${channel}`);
    if (!barEl || !titleEl || !timeEl) return;

    const countdownEl = document.getElementById(`bankCountdown-${channel}`);
    const playingPad = findPlayingPadInChannel(channel);
    if (!playingPad || !playingPad.activeSources || !playingPad.activeSources.length) {
      barEl.classList.add('seek-disabled');
      if (playheadEl) playheadEl.classList.add('hidden');
      titleEl.textContent = `Canal ${channel} en espera`;
      timeEl.textContent = '0.0s / 0.0s (0%)';
      if (countdownEl) {
        countdownEl.textContent = '00.0s';
        countdownEl.className = 'text-3xl sm:text-4xl font-mono font-black tabular-nums text-slate-500';
      }
      drawBankWaveform(channel, 0, null);
      return;
    }

    const latest = playingPad.activeSources[playingPad.activeSources.length - 1];
    const total = latest.duration || playingPad.duration || 1;
    const currentPos = getCurrentEntryPositionSeconds(channel, latest);
    const frac = clamp(currentPos / total, 0, 1);
    const pct = frac * 100;
    const bpmVal = Number(playingPad.bpm || DEFAULT_BPM).toFixed(1);
    const loopTag = playingPad.bucle ? ' · ∞' : '';

    barEl.classList.remove('seek-disabled');
    if (playheadEl) {
      playheadEl.classList.remove('hidden');
      playheadEl.style.left = `${pct.toFixed(2)}%`;
    }
    drawBankWaveform(channel, frac, playingPad);

    const remSec = Math.max(0, (total - currentPos) / Math.max(0.25, latest.playbackRate || 1));
    titleEl.textContent = `${playingPad.channel} [${playingPad.key}] · ${playingPad.label} · ${bpmVal} BPM${loopTag}`;
    timeEl.textContent = `${currentPos.toFixed(1)}s / ${total.toFixed(1)}s (${Math.round(pct)}%)`;
    if (countdownEl) {
      countdownEl.textContent = `${remSec.toFixed(1)}s${playingPad.bucle ? ' 🔁' : ''}`;
      countdownEl.className =
        remSec <= 3
          ? 'text-3xl sm:text-4xl font-mono font-black tabular-nums text-rose-400'
          : 'text-3xl sm:text-4xl font-mono font-black tabular-nums text-emerald-300';
    }
  }

  function setupBankMasterSeekEvents(channel) {
    const barEl = document.getElementById(`bankMasterSeekBar-${channel}`);
    const markerEl = document.getElementById(`bankMasterSeekHoverMarker-${channel}`);
    const labelEl = document.getElementById(`bankMasterSeekHoverLabel-${channel}`);
    if (!barEl) return;

    const computeFraction = (clientX) => {
      const rect = barEl.getBoundingClientRect();
      if (!rect.width) return 0;
      return clamp((clientX - rect.left) / rect.width, 0, 1);
    };

    barEl.addEventListener('mousemove', (e) => {
      const playingPad = findPlayingPadInChannel(channel);
      if (!playingPad || !playingPad.activeSources || !playingPad.activeSources.length) return;
      const latest = playingPad.activeSources[playingPad.activeSources.length - 1];
      const total = latest.duration || playingPad.duration || 0;
      if (total <= 0) return;

      const frac = computeFraction(e.clientX);
      const pct = Math.round(frac * 100);
      const targetSec = frac * total;

      barEl.classList.add('seek-hovering');
      if (markerEl) {
        markerEl.classList.remove('hidden');
        markerEl.style.left = `${(frac * 100).toFixed(2)}%`;
      }
      if (labelEl) {
        labelEl.classList.remove('hidden');
        labelEl.classList.add('flex');
        labelEl.textContent = `Saltar a ${pct}% (${targetSec.toFixed(2)}s / ${total.toFixed(2)}s)`;
      }
    });

    barEl.addEventListener('mouseleave', () => {
      barEl.classList.remove('seek-hovering');
      if (markerEl) markerEl.classList.add('hidden');
      if (labelEl) {
        labelEl.classList.add('hidden');
        labelEl.classList.remove('flex');
      }
    });

    barEl.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const playingPad = findPlayingPadInChannel(channel);
      if (!playingPad || !playingPad.activeSources || !playingPad.activeSources.length) {
        showToast(`No hay audio sonando en el Canal ${channel} para saltar.`, 'info');
        return;
      }

      const latest = playingPad.activeSources[playingPad.activeSources.length - 1];
      const total = latest.duration || playingPad.duration || 0;
      if (total <= 0) return;

      const frac = computeFraction(e.clientX);
      const pct = Math.round(frac * 100);
      const targetSec = clamp(frac * total, 0, Math.max(0, total - 0.02));

      if (appState.pads[playingPad.id] !== playingPad && latest.paletteId) {
        await switchBankToPalette(channel, latest.paletteId, false);
      }

      await triggerPad(playingPad.id, targetSec, true, true);
      showToast(`${playingPad.label}: saltado al ${pct}% (${targetSec.toFixed(2)}s)`, 'info');
    });
  }

  // =========================================================================
  // MEDIDOR VU POR BOTÓN
  // =========================================================================
  function resetPadVuVisual(pad) {
    pad.peakLevel = 0;
    if (pad.dom) {
      if (pad.dom.vuFill) pad.dom.vuFill.style.width = '0%';
      if (pad.dom.vuPeak) pad.dom.vuPeak.style.left = '0%';
    }
  }

  function startProgressLoop(pad) {
    stopProgressLoop(pad, false);

    const step = () => {
      if (!pad.activeSources || !pad.activeSources.length) return;
      const latest = pad.activeSources[pad.activeSources.length - 1];
      const engine = appState.engines[pad.channel];
      if (!engine || !engine.ctx) return;

      const total = latest.duration || pad.duration || 1;
      const currentPos = getCurrentEntryPositionSeconds(pad.channel, latest);
      const rate = latest.playbackRate || 1;
      const remainingRealSec = Math.max(0, (total - currentPos) / Math.max(0.25, rate));

      updateBankMasterProgressBar(pad.channel);

      if (pad.dom && pad.dom.statusBadge) {
        pad.dom.statusBadge.textContent = pad.bucle
          ? `∞ · ${remainingRealSec.toFixed(1)}s`
          : `ON · ${remainingRealSec.toFixed(1)}s`;
      }

      let level = 0;
      if (latest.analyser && latest.dataArray) {
        latest.analyser.getByteTimeDomainData(latest.dataArray);
        let sumSq = 0;
        for (let i = 0; i < latest.dataArray.length; i++) {
          const norm = Math.abs((latest.dataArray[i] - 128) / 128);
          sumSq += norm * norm;
        }
        const rms = Math.sqrt(sumSq / latest.dataArray.length);
        level = clamp(Math.pow(rms * 2.4, 0.72), 0, 1);
      } else {
        level = clamp(pad.volume * 0.6, 0, 1);
      }

      if (level >= pad.peakLevel) {
        pad.peakLevel = level;
      } else {
        pad.peakLevel = Math.max(level, pad.peakLevel - 0.014);
      }

      if (pad.dom && pad.dom.vuFill && pad.dom.vuPeak) {
        pad.dom.vuFill.style.width = `${Math.round(level * 100)}%`;
        pad.dom.vuPeak.style.left = `${clamp(Math.round(pad.peakLevel * 100), 0, 98)}%`;
      }

      pad.rafId = requestAnimationFrame(step);
    };

    pad.rafId = requestAnimationFrame(step);
  }

  function stopProgressLoop(pad, resetBar) {
    if (pad.rafId) {
      cancelAnimationFrame(pad.rafId);
      pad.rafId = null;
    }
    if (resetBar) {
      resetPadVuVisual(pad);
    }
  }

  // =========================================================================
  // ADELANTAR Y ATRASAR CON FLECHAS IZQUIERDA Y DERECHA
  // =========================================================================
  function findActivePlayingPad() {
    if (appState.selectedPadId && appState.pads[appState.selectedPadId]?.activeSources?.length) {
      return appState.pads[appState.selectedPadId];
    }
    if (appState.lastTriggeredPadId && appState.pads[appState.lastTriggeredPadId]?.activeSources?.length) {
      return appState.pads[appState.lastTriggeredPadId];
    }
    const inCurrent = Object.values(appState.pads).find((p) => p.activeSources && p.activeSources.length > 0);
    if (inCurrent) return inCurrent;
    return getAllActivePadsAcrossPalettes().find((p) => p.activeSources && p.activeSources.length > 0) || null;
  }

  async function seekActivePlayback(direction) {
    const pad = findActivePlayingPad();
    if (!pad || !pad.audioBuffer || !pad.activeSources.length) return;
    const engine = appState.engines[pad.channel];
    if (!engine || !engine.ctx) return;

    const stepSeconds =
      clamp(appState.seekStepMs, MIN_SEEK_STEP_MS, MAX_SEEK_STEP_MS) / 1000;
    if (stepSeconds <= 0) return;

    const delta = direction >= 0 ? stepSeconds : -stepSeconds;
    const latest = pad.activeSources[pad.activeSources.length - 1];
    const currentPos = getCurrentEntryPositionSeconds(pad.channel, latest);
    const rawTarget = currentPos + delta;

    const cueFloor = clamp(getPrimaryCueSeconds(pad), 0, Math.max(0, pad.audioBuffer.duration - 0.02));
    const maxPos = Math.max(cueFloor, pad.audioBuffer.duration - 0.02);

    if (rawTarget >= pad.audioBuffer.duration) {
      if (pad.bucle) {
        await triggerPad(pad.id, cueFloor, true, true);
      } else {
        stopPadInstance(pad, true);
        showToast(`${pad.label}: fin alcanzado → detenido y reseteado al CUE.`, 'info');
      }
      return;
    }

    if (appState.pads[pad.id] !== pad && latest.paletteId) {
      await switchBankToPalette(pad.channel, latest.paletteId, false);
    }

    if (rawTarget <= cueFloor) {
      await triggerPad(pad.id, cueFloor, true, true);
      return;
    }

    const clampedTarget = clamp(rawTarget, cueFloor, maxPos);
    await triggerPad(pad.id, clampedTarget, true, true);
  }

  // =========================================================================
  // VOLUMEN POR CANAL Y PITCH POR BPM
  // =========================================================================
  function getTargetPadsForBankControl(bank, preferPlaying = true) {
    if (preferPlaying) {
      const playingInBank = [];
      const seen = new Set();
      appState.activePlaybacks.forEach((pb) => {
        if (pb && pb.channel === bank && pb.padRef && !seen.has(pb.padRef)) {
          seen.add(pb.padRef);
          playingInBank.push(pb.padRef);
        }
      });
      if (playingInBank.length > 0) return playingInBank;
    }

    const selected = appState.pads[appState.selectedPadId];
    if (selected && selected.channel === bank) return [selected];
    const lastBankId = appState.lastSelectedByBank[bank];
    if (lastBankId && appState.pads[lastBankId]) return [appState.pads[lastBankId]];
    const fallbackKey = bank === 'L' ? `L-${LEFT_KEYS[0]}` : `R-${RIGHT_KEYS[0]}`;
    return appState.pads[fallbackKey] ? [appState.pads[fallbackKey]] : [];
  }

  function setPadVolume(padId, newVolume, persist = true, targetPadObj = null) {
    const pad = targetPadObj || appState.pads[padId];
    if (!pad) return;

    const clampedVol = clamp(Number(newVolume), 0, 1);
    pad.volume = clampedVol;

    pad.activeSources.forEach((entry) => {
      try {
        if (entry.mediaEl) {
          entry.mediaEl.volume = clampedVol;
        }
        if (entry.gain && appState.engines[pad.channel]?.ctx) {
          const ctx = appState.engines[pad.channel].ctx;
          entry.gain.gain.cancelScheduledValues(ctx.currentTime);
          entry.gain.gain.setValueAtTime(clampedVol, ctx.currentTime);
        }
      } catch (_) {}
    });

    if (appState.pads[pad.id] === pad) {
      renderPadVisuals(pad);
      updateSelectedPadSummary();
    }

    if (appState.contextMenu.isOpen && appState.contextMenu.padId === pad.id) {
      syncContextMenuVolumeUI(pad.volume);
    }

    if (persist) saveAllState();
  }

  function adjustBankPlayingVolume(bank, deltaPercent) {
    const targets = getTargetPadsForBankControl(bank, true);
    if (!targets.length) return;

    let lastPct = 100;
    targets.forEach((pad) => {
      const currentPct = Math.round(pad.volume * 100);
      const nextPct = clamp(currentPct + deltaPercent, 0, 100);
      lastPct = nextPct;
      setPadVolume(pad.id, nextPct / 100, false, pad);
    });
    saveAllState();

    const sideName = bank === 'L' ? 'Izquierdo (L)' : 'Derecho (R)';
    const summary =
      targets.length > 1
        ? `${targets.length} audios en ${sideName}`
        : `${targets[0].channel} ${formatPadNumber(targets[0].number)} [${targets[0].key}]`;
    showToast(`${summary} · Volumen: ${lastPct}%`, 'info');
  }

  function setPadBpm(padId, newBpm, persist = true, targetPadObj = null) {
    const pad = targetPadObj || appState.pads[padId];
    if (!pad) return;

    const clampedBpm = clamp(
      Math.round((Number(newBpm) || pad.detectedBpm || DEFAULT_BPM) * 2) / 2,
      MIN_BPM,
      MAX_BPM
    );
    pad.bpm = clampedBpm;
    const newRate = bpmToRate(clampedBpm, pad.detectedBpm || DEFAULT_BPM);

    const engine = appState.engines[pad.channel];
    pad.activeSources.forEach((entry) => {
      try {
        if (engine && engine.ctx) {
          const now = engine.ctx.currentTime;
          const currentPos = getCurrentEntryPositionSeconds(pad.channel, entry);
          entry.startOffset = currentPos;
          entry.startedAtCtxTime = now;
        }
        entry.playbackRate = newRate;
        if (entry.mediaEl) {
          applyPreservePitchToMediaElement(entry.mediaEl, appState.preservePitch);
          entry.mediaEl.playbackRate = newRate;
        }
        if (entry.source && entry.source.playbackRate && engine && engine.ctx) {
          entry.source.playbackRate.setValueAtTime(newRate, engine.ctx.currentTime);
        }
      } catch (_) {}
    });

    if (appState.pads[pad.id] === pad) {
      renderPadVisuals(pad);
      updateSelectedPadSummary();
    }
    updateBankMasterProgressBar(pad.channel);

    if (appState.contextMenu.isOpen && appState.contextMenu.padId === pad.id) {
      syncContextMenuBpmUI(clampedBpm);
    }

    if (persist) saveAllState();
  }

  function adjustBankPlayingBpm(bank, deltaBpm) {
    const targets = getTargetPadsForBankControl(bank, true);
    if (!targets.length) return;

    let lastBpm = DEFAULT_BPM;
    targets.forEach((pad) => {
      const currentBpm = Number(pad.bpm || pad.detectedBpm || DEFAULT_BPM);
      const nextBpm = clamp(currentBpm + deltaBpm, MIN_BPM, MAX_BPM);
      lastBpm = nextBpm;
      setPadBpm(pad.id, nextBpm, false, pad);
    });
    saveAllState();

    const sideName = bank === 'L' ? 'Izquierdo (L)' : 'Derecho (R)';
    const modeTag = appState.preservePitch ? ' · Tono fijo' : '';
    const summary =
      targets.length > 1
        ? `${targets.length} audios en ${sideName}`
        : `${targets[0].channel} ${formatPadNumber(targets[0].number)} [${targets[0].key}]`;
    showToast(`${summary} · Tempo: ${lastBpm.toFixed(1)} BPM${modeTag}`, 'info');
  }

  function selectPad(padId) {
    if (!appState.pads[padId]) return;
    const prevId = appState.selectedPadId;
    appState.selectedPadId = padId;
    const selPad = appState.pads[padId];
    if (selPad && (selPad.channel === 'L' || selPad.channel === 'R')) {
      appState.lastSelectedByBank[selPad.channel] = padId;
    }

    if (prevId && appState.pads[prevId]) renderPadVisuals(appState.pads[prevId]);
    renderPadVisuals(appState.pads[padId]);
    updateSelectedPadSummary();
  }

  function updateSelectedPadSummary() {
    const summaryEl = document.getElementById('selectedPadSummary');
    const bpmBadgeEl = document.getElementById('selectedBpmBadge');
    const pad = appState.pads[appState.selectedPadId] || appState.pads['L-1'];
    if (!pad) return;

    if (summaryEl) {
      summaryEl.textContent = `${pad.channel} ${formatPadNumber(pad.number)} [${pad.key}] · VOL ${Math.round(pad.volume * 100)}%`;
    }
    if (bpmBadgeEl) {
      const bpmVal = Number(pad.bpm || pad.detectedBpm || DEFAULT_BPM).toFixed(1);
      bpmBadgeEl.textContent = `${bpmVal} BPM`;
    }
  }

  // =========================================================================
  // PALETAS INDEPENDIENTES POR LADO (L / R) RESPETANDO COLORES AL ABRIR EN EL OTRO LADO
  // =========================================================================
  function pauseBankLoopsForPaletteSwitch(bank) {
    const prefix = `${bank}-`;
    Object.keys(appState.pads)
      .filter((padId) => padId.startsWith(prefix))
      .forEach((padId) => {
        const pad = appState.pads[padId];
        if (pad && pad.rafId) {
          cancelAnimationFrame(pad.rafId);
          pad.rafId = null;
        }
      });
  }

  function rebuildBankPadsFromPalette(bank, palette) {
    const prefix = `${bank}-`;
    if (!appState.palettePadsCache[palette.id]) {
      appState.palettePadsCache[palette.id] = {};
    }
    const palCache = appState.palettePadsCache[palette.id];
    const base = createDefaultPadConfigs();

    Object.keys(base)
      .filter((padId) => padId.startsWith(prefix))
      .forEach((padId) => {
        const mirrorId = getMirrorPadId(padId);
        const savedCfg = (palette.pads && palette.pads[padId]) || base[padId];
        const mirrorCfg = mirrorId && palette.pads ? palette.pads[mirrorId] : null;
        const resolvedColor =
          (savedCfg && savedCfg.color) ||
          (mirrorCfg && mirrorCfg.color) ||
          base[padId].color;

        const slotKey = getPaletteSlotKey(palette.id, padId);
        const sharedKey = getSharedSlotKey(palette.id, padId);
        const mirrorKey = mirrorId ? getPaletteSlotKey(palette.id, mirrorId) : '';
        const cachedBuffer =
          appState.decodedAudioCache[slotKey] ||
          appState.decodedAudioCache[sharedKey] ||
          (mirrorKey ? appState.decodedAudioCache[mirrorKey] : null) ||
          null;
        const normCues = normalizeCuesArray(savedCfg.cues, savedCfg.cueStart);
        const primaryCue = getPrimaryCueSeconds({ cues: normCues, cueStart: savedCfg.cueStart });
        const resolvedBpm =
          typeof savedCfg.bpm === 'number'
            ? clamp(savedCfg.bpm, MIN_BPM, MAX_BPM)
            : DEFAULT_BPM;
        const resolvedDetected =
          typeof savedCfg.detectedBpm === 'number'
            ? clamp(savedCfg.detectedBpm, MIN_BPM, MAX_BPM)
            : resolvedBpm;

        const existingPad = palCache[padId];
        if (existingPad) {
          existingPad.paletteId = palette.id;
          existingPad.label = savedCfg.label;
          existingPad.color = resolvedColor;
          existingPad.volume = clamp(typeof savedCfg.volume === 'number' ? savedCfg.volume : 1, 0, 1);
          existingPad.bpm = resolvedBpm;
          existingPad.detectedBpm = resolvedDetected;
          existingPad.triggerMode = normalizeTriggerMode(savedCfg.triggerMode);
          existingPad.bucle = Boolean(savedCfg.bucle);
          existingPad.cues = normCues;
          existingPad.cueStart = primaryCue;
          existingPad.duration = cachedBuffer
            ? cachedBuffer.duration
            : Math.max(0, Number(savedCfg.duration) || 0);
          existingPad.fileName = savedCfg.fileName || '';
          existingPad.audioBuffer = cachedBuffer;
          existingPad.dom = null;
          appState.pads[padId] = existingPad;
        } else {
          const freshPad = {
            ...base[padId],
            ...savedCfg,
            color: resolvedColor,
            paletteId: palette.id,
            volume: clamp(typeof savedCfg.volume === 'number' ? savedCfg.volume : 1, 0, 1),
            bpm: resolvedBpm,
            detectedBpm: resolvedDetected,
            triggerMode: normalizeTriggerMode(savedCfg.triggerMode),
            bucle: Boolean(savedCfg.bucle),
            cues: normCues,
            cueStart: primaryCue,
            duration: cachedBuffer
              ? cachedBuffer.duration
              : Math.max(0, Number(savedCfg.duration) || 0),
            audioBuffer: cachedBuffer,
            activeSources: [],
            fadingOutSources: [],
            rafId: null,
            peakLevel: 0,
            dom: null
          };
          palCache[padId] = freshPad;
          appState.pads[padId] = freshPad;
        }
      });
  }

  async function hydrateBankPaletteAudiosFromDB(bank, palette) {
    const prefix = `${bank}-`;
    const padIds = Object.keys(appState.pads).filter((id) => id.startsWith(prefix));

    for (const padId of padIds) {
      const pad = appState.pads[padId];
      const slotKey = getPaletteSlotKey(palette.id, padId);
      const sharedKey = getSharedSlotKey(palette.id, padId);
      const mirrorId = getMirrorPadId(padId);
      const mirrorKey = mirrorId ? getPaletteSlotKey(palette.id, mirrorId) : '';
      const alreadyCached =
        appState.decodedAudioCache[slotKey] ||
        appState.decodedAudioCache[sharedKey] ||
        (mirrorKey ? appState.decodedAudioCache[mirrorKey] : null);

      if (alreadyCached) {
        appState.decodedAudioCache[slotKey] = alreadyCached;
        appState.decodedAudioCache[sharedKey] = alreadyCached;
        if (pad && pad.paletteId === palette.id) {
          pad.audioBuffer = alreadyCached;
          pad.duration = alreadyCached.duration;
          computeWaveformPeaks(slotKey, alreadyCached);
          renderPadVisuals(pad);
        }
        continue;
      }

      try {
        let record = await loadAudioFromIndexedDB(palette.id, padId);
        if ((!record || !record.data) && mirrorId) {
          record = await loadAudioFromIndexedDB(palette.id, mirrorId);
        }
        if (record && record.data) {
          appState.rawAudioCache[slotKey] = record.data;
          createOrRefreshAudioBlobUrl(slotKey, record.data, record.fileName || '', false);
          const decoded = await decodeAudioFileBuffer(record.data);
          appState.decodedAudioCache[slotKey] = decoded;
          computeWaveformPeaks(slotKey, decoded);

          if (
            getBankPaletteId(bank) === palette.id &&
            appState.pads[padId] &&
            appState.pads[padId].paletteId === palette.id
          ) {
            const targetPad = appState.pads[padId];
            targetPad.audioBuffer = decoded;
            targetPad.duration = decoded.duration;
            targetPad.fileName = record.fileName || targetPad.fileName || 'Audio guardado';
            renderPadVisuals(targetPad);
          }
        }
      } catch (err) {
        console.warn(`Error restaurando audio de ${slotKey}:`, err);
      }
    }
  }

  async function switchBankToPalette(bank, paletteId, announce = true) {
    const target = getPaletteById(paletteId);
    if (!target) return;

    closeContextMenu();
    syncRuntimePadsIntoPaletteConfig(bank);
    pauseBankLoopsForPaletteSwitch(bank);

    appState.activePaletteByBank[bank] = target.id;
    rebuildBankPadsFromPalette(bank, target);
    renderBankPadGrid(bank);
    renderPaletteSelectorsUI();
    saveAllState();

    await hydrateBankPaletteAudiosFromDB(bank, target);

    const prefix = `${bank}-`;
    Object.keys(appState.pads)
      .filter((id) => id.startsWith(prefix))
      .forEach((padId) => {
        const pad = appState.pads[padId];
        if (pad && pad.activeSources && pad.activeSources.length > 0) {
          renderPadVisuals(pad);
          startProgressLoop(pad);
        }
      });

    updateBankMasterProgressBar(bank);

    if (announce) {
      showToast(`Paleta ${bank}: "${target.name}"`, 'info');
    }
  }

  async function stepBankPalette(bank, delta) {
    if (!appState.palettes.length) return;
    const currentId = getBankPaletteId(bank);
    const currentIdx = appState.palettes.findIndex((p) => p.id === currentId);
    const safeIdx = currentIdx >= 0 ? currentIdx : 0;
    const nextIdx = (safeIdx + delta + appState.palettes.length) % appState.palettes.length;
    await switchBankToPalette(bank, appState.palettes[nextIdx].id, true);
  }

  // =========================================================================
  // BUSCADOR GLOBAL DE TEMAS EN TODAS LAS PALETAS
  // =========================================================================
  function setupGlobalSongSearch() {
    const input = document.getElementById('songSearchInput');
    const resultsBox = document.getElementById('songSearchResults');
    if (!input || !resultsBox) return;

    const renderResults = () => {
      const q = (input.value || '').trim().toLowerCase();
      if (!q) {
        resultsBox.classList.add('hidden');
        resultsBox.innerHTML = '';
        return;
      }

      const matches = [];
      appState.palettes.forEach((pal) => {
        LEFT_KEYS.forEach((key, idx) => {
          const padId = `L-${key}`;
          const cfg = pal.pads && pal.pads[padId];
          if (!cfg) return;
          const hay = `${cfg.label || ''} ${cfg.fileName || ''}`.toLowerCase();
          if (hay.includes(q)) {
            matches.push({
              paletteId: pal.id,
              paletteName: pal.name,
              slotIdx: idx,
              leftId: `L-${LEFT_KEYS[idx]}`,
              rightId: `R-${RIGHT_KEYS[idx]}`,
              label: cfg.label || cfg.fileName || `Slot ${idx + 1}`,
              fileName: cfg.fileName || ''
            });
          }
        });
      });

      resultsBox.innerHTML = '';
      if (!matches.length) {
        resultsBox.innerHTML =
          '<div class="px-3 py-2 text-xs font-mono text-slate-400">Sin coincidencias en las paletas.</div>';
        resultsBox.classList.remove('hidden');
        return;
      }

      matches.slice(0, 20).forEach((item) => {
        const row = document.createElement('div');
        row.className = 'px-3 py-2 hover:bg-slate-800/90 flex items-center justify-between gap-2 text-xs';
        row.innerHTML = `
          <div class="min-w-0">
            <div class="font-bold text-white truncate">${item.label}</div>
            <div class="font-mono text-[10px] text-slate-400 truncate">${item.paletteName} · [${LEFT_KEYS[item.slotIdx]} / ${RIGHT_KEYS[item.slotIdx]}]</div>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button type="button" data-open-side="L" class="px-2 py-0.5 rounded bg-sky-600 hover:bg-sky-500 text-white font-mono font-bold text-[10px] cursor-pointer">L</button>
            <button type="button" data-open-side="R" class="px-2 py-0.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-mono font-bold text-[10px] cursor-pointer">R</button>
          </div>
        `;
        row.querySelectorAll('button[data-open-side]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const side = btn.getAttribute('data-open-side');
            await switchBankToPalette(side, item.paletteId, false);
            const targetPadId = side === 'L' ? item.leftId : item.rightId;
            selectPad(targetPadId);
            const cardEl = document.getElementById(`pad-card-${targetPadId}`);
            if (cardEl) {
              cardEl.classList.add('search-matched-highlight');
              if (appState.searchHighlightTimer) clearTimeout(appState.searchHighlightTimer);
              appState.searchHighlightTimer = setTimeout(() => {
                cardEl.classList.remove('search-matched-highlight');
              }, 3500);
            }
            resultsBox.classList.add('hidden');
          });
        });
        resultsBox.appendChild(row);
      });
      resultsBox.classList.remove('hidden');
    };

    input.addEventListener('input', renderResults);
    input.addEventListener('focus', renderResults);
    document.addEventListener('click', (e) => {
      const container = document.getElementById('songSearchContainer');
      if (container && !container.contains(e.target)) {
        resultsBox.classList.add('hidden');
      }
    });
  }

  // =========================================================================
  // RENDERIZADO DE LAS DOS BOTONERAS (5x3 CADA UNA + CUE 1, 2, 3 + SAMPLER)
  // =========================================================================
  function createPadElement(pad) {
    const isLeft = pad.channel === 'L';
    const card = document.createElement('div');
    card.id = `pad-card-${pad.id}`;
    card.dataset.padId = pad.id;
    card.className = 'jingle-pad-card p-2';

    const topRow = document.createElement('div');
    topRow.className = `flex items-center justify-between gap-1 z-10 ${
      isLeft ? 'flex-row' : 'flex-row-reverse'
    }`;

    const badgeCluster = document.createElement('div');
    badgeCluster.className = `flex items-center gap-1 ${
      isLeft ? 'flex-row' : 'flex-row-reverse'
    }`;

    const keyBadge = document.createElement('span');
    keyBadge.className =
      'font-mono font-black text-xl sm:text-2xl leading-none px-2.5 py-1 rounded-lg bg-slate-950/90 text-white border border-white/30 shrink-0';
    keyBadge.textContent = pad.key;

    const modeBadge = document.createElement('span');
    modeBadge.className =
      'hidden font-mono font-extrabold text-[9px] px-1.5 py-0.5 rounded bg-slate-950/85 text-amber-200 border border-amber-400/40 uppercase shrink-0';
    modeBadge.textContent = '';

    const loopBadge = document.createElement('span');
    loopBadge.className =
      'hidden font-mono font-extrabold text-sm px-1.5 py-0.5 rounded bg-emerald-500/25 text-emerald-200 border border-emerald-400/50 shrink-0';
    loopBadge.title = 'Modo bucle activado (Repeat)';
    loopBadge.textContent = '🔁';

    badgeCluster.appendChild(keyBadge);
    badgeCluster.appendChild(modeBadge);
    badgeCluster.appendChild(loopBadge);

    const statusBadge = document.createElement('span');
    statusBadge.className =
      'hidden font-mono font-bold text-[9px] px-1.5 py-0.5 rounded bg-emerald-400 text-slate-950 uppercase tracking-wider shrink-0';
    statusBadge.textContent = 'ON AIR';

    topRow.appendChild(badgeCluster);
    topRow.appendChild(statusBadge);

    const middleBox = document.createElement('div');
    middleBox.className = `my-0.5 z-10 min-h-[24px] flex flex-col justify-center ${
      isLeft ? 'text-left' : 'text-right'
    }`;

    const labelEl = document.createElement('div');
    labelEl.className = 'text-xs font-bold text-white leading-tight line-clamp-1 break-words drop-shadow';
    labelEl.textContent = pad.label;

    const subInfoEl = document.createElement('div');
    subInfoEl.className = 'text-[10px] font-mono text-white/80 truncate';
    subInfoEl.textContent = 'Vacío (Clic der.)';

    middleBox.appendChild(labelEl);
    middleBox.appendChild(subInfoEl);

    const bottomBox = document.createElement('div');
    bottomBox.className = 'z-10 space-y-1';

    const vuTrack = document.createElement('div');
    vuTrack.className = 'relative w-full h-1.5 rounded-full bg-slate-950/80 border border-white/15 overflow-hidden';

    const vuFill = document.createElement('div');
    vuFill.className = 'pad-vu-bar rounded-full';

    const vuPeak = document.createElement('div');
    vuPeak.className = 'pad-vu-peak absolute top-0 bottom-0 w-0.5 bg-white';
    vuPeak.style.left = '0%';

    vuTrack.appendChild(vuFill);
    vuTrack.appendChild(vuPeak);

    const volRow = document.createElement('div');
    volRow.className = 'flex items-center justify-between text-[10px] font-mono text-white/95 gap-1';

    const volText = document.createElement('span');
    volText.className = 'font-bold shrink-0';
    volText.textContent = `VOL ${Math.round(pad.volume * 100)}%`;

    const rightInfoText = document.createElement('span');
    rightInfoText.className = 'text-violet-200 font-bold truncate text-right';
    rightInfoText.textContent = '';

    volRow.appendChild(volText);
    volRow.appendChild(rightInfoText);

    bottomBox.appendChild(vuTrack);
    bottomBox.appendChild(volRow);

    // Tira CUE 1, 2 y 3 integrada directamente debajo del botón
    const cueStrip = document.createElement('div');
    cueStrip.className = 'cue-integrated-strip z-10';
    const cueMiniBtns = [];

    for (let i = 0; i < 3; i++) {
      const cBtn = document.createElement('button');
      cBtn.type = 'button';
      cBtn.className = 'cue-integrated-btn font-mono text-amber-200/80 hover:bg-amber-400 hover:text-slate-950 cursor-pointer truncate';
      cBtn.textContent = `CUE ${i + 1}`;
      cBtn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
      });
      cBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeContextMenu();
        selectPad(pad.id);
        const cues = normalizeCuesArray(pad.cues, pad.cueStart);
        const targetSec = typeof cues[i] === 'number' ? cues[i] : getPrimaryCueSeconds(pad);
        triggerPad(pad.id, targetSec, true, true);
      });
      cueStrip.appendChild(cBtn);
      cueMiniBtns.push(cBtn);
    }

    card.appendChild(topRow);
    card.appendChild(middleBox);
    card.appendChild(bottomBox);
    card.appendChild(cueStrip);

    pad.dom = {
      card,
      keyBadge,
      modeBadge,
      loopBadge,
      statusBadge,
      labelEl,
      subInfoEl,
      vuFill,
      vuPeak,
      volText,
      rightInfoText,
      cueMiniBtns
    };

    // Soporte Modo Sampler con mouse/táctil (mantener presionado suena, al soltar para)
    card.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target && e.target.closest('.cue-integrated-btn')) return;
      if (normalizeTriggerMode(pad.triggerMode) === 'sampler') {
        e.preventDefault();
        closeContextMenu();
        selectPad(pad.id);
        appState.heldSamplerPointers.set(e.pointerId, pad.id);
        try {
          card.setPointerCapture(e.pointerId);
        } catch (_) {}
        triggerPad(pad.id);
      }
    });

    const releasePointerSampler = (e) => {
      const heldPadId = appState.heldSamplerPointers.get(e.pointerId);
      if (heldPadId) {
        appState.heldSamplerPointers.delete(e.pointerId);
        const heldPad = appState.pads[heldPadId];
        if (heldPad && normalizeTriggerMode(heldPad.triggerMode) === 'sampler') {
          stopPadInstance(heldPad, false);
        }
      }
    };
    card.addEventListener('pointerup', releasePointerSampler);
    card.addEventListener('pointercancel', releasePointerSampler);

    card.addEventListener('click', (e) => {
      e.preventDefault();
      // En modo sampler ya se disparó en pointerdown
      if (normalizeTriggerMode(pad.triggerMode) === 'sampler') return;
      closeContextMenu();
      selectPad(pad.id);
      if (e.shiftKey) {
        triggerInteractiveFadeStop(pad.id);
      } else {
        triggerPad(pad.id);
      }
    });

    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectPad(pad.id);
      openContextMenu(pad.id, e.clientX, e.clientY);
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      card.classList.add('drag-over');
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });

    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const files = e.dataTransfer && e.dataTransfer.files;
      const bankPal = getBankPalette(pad.channel);
      if (files && files.length > 0 && bankPal) {
        await assignAudioFileToPad(bankPal.id, pad.id, files[0]);
      }
    });

    renderPadVisuals(pad);
    return card;
  }

  function renderPadVisuals(pad) {
    if (!pad || !pad.dom) return;
    const {
      card,
      modeBadge,
      loopBadge,
      statusBadge,
      labelEl,
      subInfoEl,
      volText,
      rightInfoText,
      cueMiniBtns
    } = pad.dom;

    const isPlaying = pad.activeSources && pad.activeSources.length > 0;
    const isSelected = appState.selectedPadId === pad.id;
    const hasAudio = Boolean(pad.audioBuffer);
    const mode = normalizeTriggerMode(pad.triggerMode);

    card.style.background = hasAudio
      ? `linear-gradient(155deg, ${pad.color}ee 0%, ${pad.color}99 100%)`
      : `linear-gradient(155deg, ${pad.color}55 0%, #151c2b 100%)`;

    if (isPlaying) {
      card.classList.add('pad-playing');
      card.style.borderColor = '';
      card.style.boxShadow = '';
      statusBadge.classList.remove('hidden');
    } else {
      card.classList.remove('pad-playing');
      statusBadge.classList.add('hidden');
      resetPadVuVisual(pad);

      if (isSelected) {
        card.style.borderColor = '#f8fafc';
        card.style.boxShadow = '0 0 0 2px rgba(248, 250, 252, 0.55), 0 8px 16px -4px rgba(0, 0, 0, 0.45)';
      } else {
        card.style.borderColor = hasAudio ? pad.color : 'rgba(148, 163, 184, 0.25)';
        card.style.boxShadow = '';
      }
    }

    if (modeBadge) {
      if (mode === 'single') {
        modeBadge.textContent = 'SINGLE';
        modeBadge.className =
          'font-mono font-extrabold text-[9px] px-1.5 py-0.5 rounded bg-amber-500/25 text-amber-200 border border-amber-400/50 uppercase shrink-0';
      } else if (mode === 'sampler') {
        modeBadge.textContent = 'SAMPLER';
        modeBadge.className =
          'font-mono font-extrabold text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/25 text-emerald-200 border border-emerald-400/50 uppercase shrink-0';
      } else {
        modeBadge.className = 'hidden';
      }
    }

    labelEl.textContent = pad.label;

    if (hasAudio) {
      subInfoEl.textContent = `${formatSeconds(pad.duration)} · ${pad.fileName || 'Audio listo'}`;
      subInfoEl.className = 'text-[10px] font-mono text-white/90 truncate';
    } else if (pad.fileName) {
      subInfoEl.textContent = `Cargando: ${pad.fileName}`;
      subInfoEl.className = 'text-[10px] font-mono text-amber-300 truncate';
    } else {
      subInfoEl.textContent = 'Vacío (Clic der.)';
      subInfoEl.className = 'text-[10px] font-mono text-slate-300/75 truncate';
    }

    const volPct = Math.round(pad.volume * 100);
    volText.textContent = `VOL ${volPct}%`;

    if (loopBadge) {
      loopBadge.classList.toggle('hidden', !Boolean(pad.bucle));
    }
    const bpmVal = Number(pad.bpm || pad.detectedBpm || DEFAULT_BPM);
    const bucleMark = pad.bucle ? ' 🔁' : '';
    rightInfoText.textContent = hasAudio ? `${bpmVal.toFixed(1)} BPM${bucleMark}` : (pad.bucle ? '🔁' : '');

    const cues = normalizeCuesArray(pad.cues, pad.cueStart);
    if (Array.isArray(cueMiniBtns)) {
      cueMiniBtns.forEach((btn, idx) => {
        const val = cues[idx];
        if (typeof val === 'number' && val >= 0) {
          btn.textContent = `CUE ${idx + 1} (${val.toFixed(1)}s)`;
          btn.className =
            'cue-integrated-btn font-mono text-amber-300 bg-amber-500/15 hover:bg-amber-400 hover:text-slate-950 cursor-pointer truncate';
          btn.title = `CUE ${idx + 1}: ${val.toFixed(2)}s`;
        } else {
          btn.textContent = `CUE ${idx + 1}`;
          btn.className =
            'cue-integrated-btn font-mono text-slate-400 hover:bg-amber-400 hover:text-slate-950 cursor-pointer truncate';
          btn.title = `CUE ${idx + 1} sin punto definido`;
        }
      });
    }
  }

  function renderBankPadGrid(bank) {
    const gridEl = document.getElementById(`padGrid-${bank}`);
    if (!gridEl) return;
    gridEl.innerHTML = '';

    const keys = bank === 'L' ? LEFT_KEYS : RIGHT_KEYS;
    keys.forEach((key) => {
      const pad = appState.pads[`${bank}-${key}`];
      if (pad) gridEl.appendChild(createPadElement(pad));
    });

    updateSelectedPadSummary();
  }

  function renderAllPadGrids() {
    renderBankPadGrid('L');
    renderBankPadGrid('R');
  }

  // =========================================================================
  // CARGA Y REEMPLAZO DE ARCHIVOS DE AUDIO + DETECCIÓN DE BPM REAL
  // =========================================================================
  async function assignAudioFileToPad(targetPaletteId, padId, file) {
    const targetPalette = getPaletteById(targetPaletteId);
    if (!targetPalette || !file) return;

    const bank = padId.startsWith('L-') ? 'L' : 'R';
    const slotKey = getPaletteSlotKey(targetPalette.id, padId);

    delete appState.decodedAudioCache[slotKey];
    delete appState.rawAudioCache[slotKey];
    delete appState.waveformPeaksCache[slotKey];
    if (appState.audioBlobUrlCache[slotKey]) {
      try {
        URL.revokeObjectURL(appState.audioBlobUrlCache[slotKey]);
      } catch (_) {}
      delete appState.audioBlobUrlCache[slotKey];
    }

    const paletteMap = appState.palettePadsCache[targetPalette.id] || {};
    const cachedPad = paletteMap[padId];
    const activeBankPad =
      getBankPaletteId(bank) === targetPalette.id ? appState.pads[padId] : null;

    [cachedPad, activeBankPad].forEach((p) => {
      if (p) {
        stopPadInstance(p, true);
        p.audioBuffer = null;
        p.duration = 0;
        p.fileName = file.name;
        if (appState.pads[padId] === p) renderPadVisuals(p);
      }
    });

    try {
      const arrayBuffer = await file.arrayBuffer();
      const decoded = await decodeAudioFileBuffer(arrayBuffer);
      const realBpm = detectRealBPM(decoded);

      const sharedKey = getSharedSlotKey(targetPalette.id, padId);
      const mirrorId = getMirrorPadId(padId);
      const mirrorSlotKey = mirrorId ? getPaletteSlotKey(targetPalette.id, mirrorId) : null;

      [slotKey, sharedKey, mirrorSlotKey].filter(Boolean).forEach((k) => {
        appState.decodedAudioCache[k] = decoded;
        appState.rawAudioCache[k] = arrayBuffer.slice(0);
        createOrRefreshAudioBlobUrl(k, arrayBuffer, file.name, true);
        computeWaveformPeaks(k, decoded);
      });

      await saveAudioToIndexedDB(targetPalette.id, padId, arrayBuffer, file.name);
      if (mirrorId) {
        await saveAudioToIndexedDB(targetPalette.id, mirrorId, arrayBuffer, file.name);
      }
      await writeAudioFileToLocalFolder(targetPalette.id, padId, file.name, arrayBuffer);

      const baseCfg = createDefaultPadConfigs()[padId];
      const prevCfg = (targetPalette.pads && targetPalette.pads[padId]) || baseCfg;
      const cleanTitle =
        file.name.replace(/\.[^/.]+$/, '').slice(0, 32) || prevCfg.label || baseCfg.label;

      const oldCues = normalizeCuesArray(prevCfg.cues, prevCfg.cueStart);
      const newCues = oldCues.map((c) =>
        typeof c === 'number' && c < decoded.duration - 0.02 ? c : null
      );
      const newPrimaryCue = getPrimaryCueSeconds({ cues: newCues, cueStart: 0 });
      const preservedColor = prevCfg.color || baseCfg.color;

      const updatedCfg = {
        ...baseCfg,
        ...prevCfg,
        id: padId,
        label: cleanTitle,
        color: preservedColor,
        bpm: realBpm,
        detectedBpm: realBpm,
        cueStart: newPrimaryCue,
        cues: newCues,
        duration: decoded.duration,
        fileName: file.name,
        hasAudio: true
      };

      targetPalette.pads[padId] = updatedCfg;
      if (mirrorId) {
        const mirrorBase = createDefaultPadConfigs()[mirrorId];
        const mirrorPrev = (targetPalette.pads && targetPalette.pads[mirrorId]) || mirrorBase;
        targetPalette.pads[mirrorId] = {
          ...mirrorBase,
          ...mirrorPrev,
          id: mirrorId,
          label: cleanTitle,
          color: preservedColor,
          bpm: realBpm,
          detectedBpm: realBpm,
          cueStart: newPrimaryCue,
          cues: [...newCues],
          duration: decoded.duration,
          fileName: file.name,
          hasAudio: true
        };
      }

      const mirrorCachedPad = mirrorId ? paletteMap[mirrorId] : null;
      const mirrorActivePad =
        mirrorId && getBankPaletteId(bank === 'L' ? 'R' : 'L') === targetPalette.id
          ? appState.pads[mirrorId]
          : null;

      [cachedPad, activeBankPad, mirrorCachedPad, mirrorActivePad].forEach((p) => {
        if (p) {
          p.audioBuffer = decoded;
          p.duration = decoded.duration;
          p.fileName = file.name;
          p.label = cleanTitle;
          p.color = preservedColor;
          p.bpm = realBpm;
          p.detectedBpm = realBpm;
          p.cues = [...newCues];
          p.cueStart = newPrimaryCue;
          if (appState.pads[p.id] === p) renderPadVisuals(p);
        }
      });

      const otherBank = bank === 'L' ? 'R' : 'L';
      if (getBankPaletteId(otherBank) === targetPalette.id) {
        updateBankMasterProgressBar(otherBank);
      }
      updateBankMasterProgressBar(bank);
      updateSelectedPadSummary();

      saveAllState();

      if (
        appState.contextMenu.isOpen &&
        appState.contextMenu.padId === padId &&
        appState.contextMenu.paletteId === targetPalette.id &&
        activeBankPad
      ) {
        document.getElementById('ctxLabelInput').value = activeBankPad.label;
        document.getElementById('ctxPadFileInfo').textContent = `${file.name} (${formatSeconds(decoded.duration)})`;
        syncContextMenuBpmUI(realBpm);
        syncContextMenuCueBounds(activeBankPad);
      }

      showToast(`${file.name} · ${realBpm.toFixed(1)} BPM detectados`, 'success');
    } catch (err) {
      console.error('Error al decodificar archivo de audio:', err);
      showToast('Formato de audio no compatible o archivo dañado.', 'error');
    }
  }

  async function clearSinglePadAudio(targetPaletteId, padId) {
    const targetPalette = getPaletteById(targetPaletteId);
    if (!targetPalette) return;

    const bank = padId.startsWith('L-') ? 'L' : 'R';
    const slotKey = getPaletteSlotKey(targetPalette.id, padId);

    delete appState.decodedAudioCache[slotKey];
    delete appState.rawAudioCache[slotKey];
    delete appState.waveformPeaksCache[slotKey];
    if (appState.audioBlobUrlCache[slotKey]) {
      try {
        URL.revokeObjectURL(appState.audioBlobUrlCache[slotKey]);
      } catch (_) {}
      delete appState.audioBlobUrlCache[slotKey];
    }

    await deletePadAudioFromIndexedDB(targetPalette.id, padId);

    const baseCfg = createDefaultPadConfigs()[padId];
    const prevCfg = (targetPalette.pads && targetPalette.pads[padId]) || baseCfg;
    targetPalette.pads[padId] = {
      ...baseCfg,
      ...prevCfg,
      id: padId,
      label: baseCfg.label,
      bpm: DEFAULT_BPM,
      detectedBpm: DEFAULT_BPM,
      bucle: false,
      cueStart: 0,
      cues: [null, null, null],
      duration: 0,
      fileName: '',
      hasAudio: false
    };

    const paletteMap = appState.palettePadsCache[targetPalette.id] || {};
    const cachedPad = paletteMap[padId];
    const activeBankPad =
      getBankPaletteId(bank) === targetPalette.id ? appState.pads[padId] : null;

    [cachedPad, activeBankPad].forEach((p) => {
      if (p) {
        stopPadInstance(p, true);
        p.audioBuffer = null;
        p.duration = 0;
        p.fileName = '';
        p.bpm = DEFAULT_BPM;
        p.detectedBpm = DEFAULT_BPM;
        p.bucle = false;
        p.cueStart = 0;
        p.cues = [null, null, null];
        p.label = baseCfg.label;
        if (appState.pads[padId] === p) renderPadVisuals(p);
      }
    });

    saveAllState();
    if (appState.contextMenu.isOpen && appState.contextMenu.padId === padId) {
      closeContextMenu();
    }
    showToast(
      `Audio eliminado de "${targetPalette.name}" (${baseCfg.channel} ${formatPadNumber(baseCfg.number)} [${baseCfg.key}]).`,
      'info'
    );
  }

  // =========================================================================
  // PRE-ESCUCHA Y EDICIÓN DE LOS 3 PUNTOS CUE + 3 MODOS EN MENÚ CONTEXTUAL
  // =========================================================================
  function stopCueLoopPreview() {
    appState.contextMenu.cueLoopActive = false;
    if (appState.contextMenu.cueLoopTimer) {
      clearTimeout(appState.contextMenu.cueLoopTimer);
      appState.contextMenu.cueLoopTimer = null;
    }
    if (appState.contextMenu.cueLoopSource) {
      try {
        appState.contextMenu.cueLoopSource.onended = null;
        appState.contextMenu.cueLoopSource.stop();
        appState.contextMenu.cueLoopSource.disconnect();
      } catch (_) {}
      appState.contextMenu.cueLoopSource = null;
    }
    if (appState.contextMenu.cueLoopGain) {
      try {
        appState.contextMenu.cueLoopGain.disconnect();
      } catch (_) {}
      appState.contextMenu.cueLoopGain = null;
    }
    const statusEl = document.getElementById('ctxCueLoopStatus');
    if (statusEl) {
      statusEl.textContent = 'Mudo';
      statusEl.className = 'font-mono text-[10px] text-slate-400';
    }
  }

  async function startCueLoopPreview(pad, cueSec) {
    stopCueLoopPreview();
    if (!pad || !pad.audioBuffer || pad.duration <= 0) return;

    const maxPos = Math.max(0, pad.duration - 0.01);
    const safeCue = clamp(Number(cueSec) || 0, 0, maxPos);
    appState.contextMenu.cueDraftSeconds = safeCue;
    appState.contextMenu.cueLoopActive = true;

    const pulseMs = clamp(
      Number(appState.cueLoopMs) || DEFAULT_CUE_LOOP_MS,
      MIN_CUE_LOOP_MS,
      MAX_CUE_LOOP_MS
    );
    appState.cueLoopMs = pulseMs;

    const slotNum = appState.contextMenu.activeCueSlot + 1;
    const statusEl = document.getElementById('ctxCueLoopStatus');
    if (statusEl) {
      statusEl.textContent = `CUE ${slotNum} · ${pulseMs}ms @ ${safeCue.toFixed(2)}s`;
      statusEl.className = 'font-mono text-[10px] text-amber-300 font-bold';
    }

    const runPulse = async () => {
      if (!appState.contextMenu.isOpen || !appState.contextMenu.cueLoopActive) return;
      if (appState.contextMenu.padId !== pad.id || !pad.audioBuffer) return;

      try {
        const engine = await ensureBankEngineReady(pad.channel);
        if (!engine || !engine.ctx || !appState.contextMenu.cueLoopActive) return;

        const ctx = engine.ctx;
        const now = ctx.currentTime;
        const sliceSec = Math.max(0.005, pulseMs / 1000);
        const availableSec = Math.max(0.005, pad.audioBuffer.duration - safeCue);
        const actualDur = Math.min(sliceSec, availableSec);

        const src = ctx.createBufferSource();
        src.buffer = pad.audioBuffer;
        src.playbackRate.value = bpmToRate(pad.bpm || DEFAULT_BPM, pad.detectedBpm || DEFAULT_BPM);

        const gain = ctx.createGain();
        const targetGain = clamp(pad.volume, 0.1, 1);
        const fadeSec = Math.min(0.004, actualDur * 0.15);

        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(targetGain, now + fadeSec);
        if (actualDur > fadeSec * 2) {
          gain.gain.setValueAtTime(targetGain, now + actualDur - fadeSec);
        }
        gain.gain.linearRampToValueAtTime(0.0001, now + actualDur);

        src.connect(gain);
        connectNodeToBankOutput(engine, gain);

        appState.contextMenu.cueLoopSource = src;
        appState.contextMenu.cueLoopGain = gain;

        src.start(now, safeCue, actualDur);
      } catch (_) {}

      if (appState.contextMenu.isOpen && appState.contextMenu.cueLoopActive) {
        appState.contextMenu.cueLoopTimer = setTimeout(runPulse, pulseMs);
      }
    };

    await runPulse();
  }

  function renderContextMenuTriggerModeUI(mode) {
    const cleanMode = normalizeTriggerMode(mode);
    const chkNormal = document.getElementById('ctxModeNormalChk');
    const chkSingle = document.getElementById('ctxModeSingleChk');
    const chkSampler = document.getElementById('ctxModeSamplerChk');

    if (chkNormal) chkNormal.checked = cleanMode === 'normal';
    if (chkSingle) chkSingle.checked = cleanMode === 'single';
    if (chkSampler) chkSampler.checked = cleanMode === 'sampler';
  }

  function syncContextMenuVolumeUI(vol) {
    const pct = Math.round(clamp(vol, 0, 1) * 100);
    const slider = document.getElementById('ctxVolSlider');
    const valEl = document.getElementById('ctxVolValue');
    if (slider) slider.value = String(pct);
    if (valEl) valEl.textContent = `${pct}%`;
  }

  function syncContextMenuBpmUI(bpmVal) {
    const cleanBpm = clamp(Number(bpmVal) || DEFAULT_BPM, MIN_BPM, MAX_BPM);
    const slider = document.getElementById('ctxBpmSlider');
    const valEl = document.getElementById('ctxBpmValue');
    if (slider) slider.value = String(cleanBpm);
    if (valEl) valEl.textContent = `${cleanBpm.toFixed(1)} BPM`;
  }

  function renderContextMenuCueSlotTabs(pad) {
    const cues = normalizeCuesArray(pad.cues, pad.cueStart);
    const activeSlot = appState.contextMenu.activeCueSlot || 0;
    document.querySelectorAll('.ctx-cue-slot-tab').forEach((btn) => {
      const idx = Number(btn.getAttribute('data-cue-slot'));
      const val = cues[idx];
      btn.textContent =
        typeof val === 'number' && val >= 0
          ? `CUE ${idx + 1}: ${val.toFixed(2)}s`
          : `CUE ${idx + 1}: --`;
      if (idx === activeSlot) {
        btn.className =
          'ctx-cue-slot-tab py-1 px-2 rounded-lg font-mono font-extrabold text-[11px] bg-amber-500 text-slate-950 cursor-pointer transition';
      } else {
        btn.className =
          'ctx-cue-slot-tab py-1 px-2 rounded-lg font-mono font-bold text-[11px] bg-slate-800 text-slate-300 hover:bg-slate-700 cursor-pointer transition';
      }
    });
  }

  function selectContextMenuCueSlot(pad, slotIdx) {
    stopCueLoopPreview();
    const safeSlot = clamp(Number(slotIdx) || 0, 0, 2);
    appState.contextMenu.activeCueSlot = safeSlot;

    const cues = normalizeCuesArray(pad.cues, pad.cueStart);
    const maxCue = pad.audioBuffer && pad.duration > 0 ? Math.max(0, pad.duration - 0.01) : 60;
    const slotSec =
      typeof cues[safeSlot] === 'number'
        ? clamp(cues[safeSlot], 0, maxCue)
        : 0;

    appState.contextMenu.cueDraftSeconds = slotSec;
    const slider = document.getElementById('ctxCueSlider');
    const numInput = document.getElementById('ctxCueNumber');
    if (slider) {
      slider.max = String(maxCue);
      slider.value = String(slotSec);
    }
    if (numInput) {
      numInput.max = String(maxCue);
      numInput.value = slotSec.toFixed(2);
    }
    renderContextMenuCueSlotTabs(pad);
  }

  function syncContextMenuCueBounds(pad) {
    selectContextMenuCueSlot(pad, appState.contextMenu.activeCueSlot || 0);
    const msInput = document.getElementById('ctxCueLoopMsInput');
    if (msInput) msInput.value = String(appState.cueLoopMs);
  }

  function renderContextMenuColorSwatches(selectedColor) {
    const container = document.getElementById('ctxColorSwatches');
    if (!container) return;
    container.innerHTML = '';

    COLOR_SWATCHES.forEach((hex) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `w-6 h-6 rounded-md border transition cursor-pointer ${
        selectedColor.toLowerCase() === hex.toLowerCase()
          ? 'border-white scale-110 ring-2 ring-white/60'
          : 'border-white/20 hover:scale-105'
      }`;
      btn.style.backgroundColor = hex;
      btn.addEventListener('click', () => {
        const pad = appState.pads[appState.contextMenu.padId];
        if (!pad) return;
        pad.color = hex;
        document.getElementById('ctxCustomColorInput').value = hex;
        renderContextMenuColorSwatches(hex);
        renderPadVisuals(pad);
        saveAllState();
      });
      container.appendChild(btn);
    });
  }

  function openContextMenu(padId, clientX, clientY) {
    const pad = appState.pads[padId];
    const menu = document.getElementById('padContextMenu');
    if (!pad || !menu) return;

    stopCueLoopPreview();
    const activeBankPal = getBankPalette(pad.channel);
    appState.contextMenu.isOpen = true;
    appState.contextMenu.padId = padId;
    appState.contextMenu.paletteId = activeBankPal ? activeBankPal.id : pad.paletteId;
    appState.contextMenu.activeCueSlot = 0;

    document.getElementById('ctxPadTitle').textContent = `${pad.channel} ${formatPadNumber(pad.number)} [Tecla ${pad.key}]`;
    document.getElementById('ctxPadFileInfo').textContent = pad.audioBuffer
      ? `${pad.fileName} (${formatSeconds(pad.duration)})`
      : 'Sin audio cargado';

    document.getElementById('ctxLabelInput').value = pad.label;
    document.getElementById('ctxCustomColorInput').value = pad.color;
    renderContextMenuColorSwatches(pad.color);
    renderContextMenuTriggerModeUI(pad.triggerMode);

    const bucleCheckbox = document.getElementById('ctxBucleCheckbox');
    if (bucleCheckbox) {
      bucleCheckbox.checked = Boolean(pad.bucle);
    }

    syncContextMenuVolumeUI(pad.volume);
    syncContextMenuBpmUI(pad.bpm || pad.detectedBpm || DEFAULT_BPM);
    syncContextMenuCueBounds(pad);

    menu.classList.remove('hidden');

    const menuRect = menu.getBoundingClientRect();
    const left = clamp(clientX, 10, Math.max(10, window.innerWidth - menuRect.width - 10));
    const top = clamp(clientY, 10, Math.max(10, window.innerHeight - menuRect.height - 10));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function closeContextMenu() {
    stopCueLoopPreview();
    const menu = document.getElementById('padContextMenu');
    if (menu) menu.classList.add('hidden');
    appState.contextMenu.isOpen = false;
    appState.contextMenu.padId = null;
    appState.contextMenu.paletteId = null;
  }

  // =========================================================================
  // UI DE PALETAS EN AMBOS LADOS, FADE POR PALETA, MODO FADE/CUT Y PLACAS
  // =========================================================================
  function renderPaletteSelectorsUI() {
    ['L', 'R'].forEach((bank) => {
      const pal = getBankPalette(bank);
      const selectEl = document.getElementById(`paletteSelect-${bank}`);
      const nameInput = document.getElementById(`paletteNameInput-${bank}`);
      const fadeSlider = document.getElementById(`paletteFadeSlider-${bank}`);
      const fadeNum = document.getElementById(`paletteFadeNumber-${bank}`);
      const fadeSecLabel = document.getElementById(`paletteFadeSecLabel-${bank}`);
      const fadeGearBtn = document.getElementById(`paletteFadeGearBtn-${bank}`);

      if (selectEl) {
        selectEl.innerHTML = '';
        appState.palettes.forEach((item) => {
          const opt = document.createElement('option');
          opt.value = item.id;
          const fadeTag = item.fadeMs > 0 ? ` (${item.fadeMs}ms)` : '';
          opt.textContent = `${item.name}${fadeTag}`;
          selectEl.appendChild(opt);
        });
        if (pal) selectEl.value = pal.id;
      }

      if (nameInput && pal) {
        nameInput.value = pal.name;
      }

      const palFade = pal ? clamp(Number(pal.fadeMs) || 0, MIN_FADE_MS, MAX_FADE_MS) : 0;
      if (fadeSlider) fadeSlider.value = String(palFade);
      if (fadeNum) fadeNum.value = String(palFade);
      if (fadeSecLabel) fadeSecLabel.textContent = `${(palFade / 1000).toFixed(2)} s`;
      if (fadeGearBtn) {
        fadeGearBtn.textContent = palFade > 0 ? `⚙ ${palFade}ms` : '⚙ Fade';
      }
    });
  }

  function renderTransitionModeUI() {
    const isFade = appState.transition.mode === 'fade';
    const badgeBtn = document.getElementById('toggleTransitionModeBtn');
    const cutCard = document.getElementById('selectCutModeBtn');
    const fadeCard = document.getElementById('selectFadeModeBtn');

    if (badgeBtn) {
      badgeBtn.textContent = isFade
        ? `Modo: Fade (${appState.transition.fadeInMs}/${appState.transition.fadeOutMs} ms)`
        : 'Modo: Corte Automático';
      badgeBtn.className = isFade
        ? 'px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-400/50 cursor-pointer transition'
        : 'px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/35 cursor-pointer transition';
    }

    const fadesOpenBtn = document.getElementById('openFadesModalBtn');
    if (fadesOpenBtn) {
      fadesOpenBtn.textContent = `Fades (In ${appState.transition.fadeInMs} / Out ${appState.transition.fadeOutMs} / Int ${appState.transition.interactiveFadeMs}ms)`;
    }

    const pitchBtn = document.getElementById('togglePreservePitchBtn');
    if (pitchBtn) {
      const fixed = Boolean(appState.preservePitch);
      pitchBtn.textContent = fixed ? 'Tono: Fijo (BPM Real)' : 'Tono: Varía con BPM';
      pitchBtn.className = fixed
        ? 'px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-violet-500/20 hover:bg-violet-500/30 text-violet-200 border border-violet-400/45 cursor-pointer transition'
        : 'px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-600 cursor-pointer transition';
    }

    if (cutCard && fadeCard) {
      if (!isFade) {
        cutCard.className =
          'p-3 rounded-xl border text-left transition cursor-pointer bg-emerald-500/15 border-emerald-400 text-emerald-100';
        fadeCard.className =
          'p-3 rounded-xl border text-left transition cursor-pointer bg-slate-950 border-slate-700 text-slate-300 hover:border-slate-500';
      } else {
        cutCard.className =
          'p-3 rounded-xl border text-left transition cursor-pointer bg-slate-950 border-slate-700 text-slate-300 hover:border-slate-500';
        fadeCard.className =
          'p-3 rounded-xl border text-left transition cursor-pointer bg-amber-500/15 border-amber-400 text-amber-100';
      }
    }

    const inSlider = document.getElementById('fadeInMsSlider');
    const inInput = document.getElementById('fadeInMsInput');
    const outSlider = document.getElementById('fadeOutMsSlider');
    const outInput = document.getElementById('fadeOutMsInput');
    const intSlider = document.getElementById('interactiveFadeMsSlider');
    const intInput = document.getElementById('interactiveFadeMsInput');

    if (inSlider) inSlider.value = String(appState.transition.fadeInMs);
    if (inInput) inInput.value = String(appState.transition.fadeInMs);
    if (outSlider) outSlider.value = String(appState.transition.fadeOutMs);
    if (outInput) outInput.value = String(appState.transition.fadeOutMs);
    if (intSlider) intSlider.value = String(appState.transition.interactiveFadeMs);
    if (intInput) intInput.value = String(appState.transition.interactiveFadeMs);
  }

  function renderModalSeekStepUI() {
    const msVal = clamp(Math.round(appState.seekStepMs), MIN_SEEK_STEP_MS, MAX_SEEK_STEP_MS);
    const slider = document.getElementById('modalSeekStepSlider');
    const numInput = document.getElementById('modalSeekStepNumber');
    const secLabel = document.getElementById('modalSeekSecEquivalent');

    if (slider) slider.value = String(msVal);
    if (numInput) numInput.value = String(msVal);
    if (secLabel) secLabel.textContent = `(${(msVal / 1000).toFixed(2)} s)`;
  }

  function setSeekStepMs(rawMs) {
    const val = clamp(Math.round(Number(rawMs) || 0), MIN_SEEK_STEP_MS, MAX_SEEK_STEP_MS);
    appState.seekStepMs = val;
    renderModalSeekStepUI();
    saveAllState();
  }

  async function refreshAudioDevices(requestPerm = false) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      renderAudioRoutingUI();
      return;
    }

    try {
      if (requestPerm && navigator.mediaDevices.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((t) => t.stop());
          appState.audioPermissionGranted = true;
        } catch (_) {}
      }

      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter((d) => d.kind === 'audiooutput');
      const unique = [];
      const seen = new Set();

      outputs.forEach((dev) => {
        const key = `${dev.deviceId || ''}::${dev.label || ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(dev);
        }
      });

      appState.outputDevices = unique;
      if (unique.some((d) => d.label && d.label.trim().length > 0)) {
        appState.audioPermissionGranted = true;
      }

      ['L', 'R'].forEach((bank) => {
        const savedId = appState.routing[bank].deviceId;
        if (savedId) {
          const found = unique.find((d) => d.deviceId === savedId);
          if (found && found.label) {
            appState.routing[bank].deviceLabel = found.label;
          }
        }
      });

      renderAudioRoutingUI();
      saveAllState();

      if (requestPerm) {
        showToast(`Detectadas ${unique.length} salida(s) de audio.`, 'success');
      }
    } catch (err) {
      console.warn('Error al enumerar salidas de audio:', err);
      renderAudioRoutingUI();
    }
  }

  function renderAudioRoutingUI() {
    ['L', 'R'].forEach((bank) => {
      const devSelect = document.getElementById(`deviceSelect-${bank}`);
      const chSelect = document.getElementById(`channelSelect-${bank}`);
      const badge = document.getElementById(`bankRoutingBadge-${bank}`);
      const cfg = appState.routing[bank];
      const eng = appState.engines[bank];

      if (devSelect) {
        devSelect.innerHTML = '';
        const defaultOpt = document.createElement('option');
        defaultOpt.value = '';
        defaultOpt.textContent = 'Salida predeterminada del sistema';
        devSelect.appendChild(defaultOpt);

        appState.outputDevices.forEach((dev, idx) => {
          if (!dev.deviceId || dev.deviceId === 'default') return;
          const opt = document.createElement('option');
          opt.value = dev.deviceId;
          opt.textContent = dev.label || `Placa de salida #${idx + 1}`;
          devSelect.appendChild(opt);
        });

        const validIds = new Set(Array.from(devSelect.options).map((o) => o.value));
        devSelect.value = validIds.has(cfg.deviceId) ? cfg.deviceId : '';
      }

      const maxChannels = (eng && eng.maxChannels) || 2;
      populateChannelSelectOptions(chSelect, maxChannels, cfg.channelMode);

      if (badge) {
        const devName = cfg.deviceId
          ? cfg.deviceLabel || 'Placa asignada'
          : 'Salida predeterminada';
        const chText = chSelect && chSelect.selectedOptions[0]
          ? chSelect.selectedOptions[0].textContent
          : cfg.channelMode.toUpperCase();
        badge.textContent = `${devName} · ${chText}`;
      }
    });

    renderLimiterUI();

    const countEl = document.getElementById('diagDeviceCount');
    const sinkEl = document.getElementById('diagSinkCapability');
    const permEl = document.getElementById('diagPermStatus');
    const listEl = document.getElementById('diagDeviceList');

    if (countEl) countEl.textContent = String(appState.outputDevices.length);
    if (sinkEl) {
      const hasCtxSink =
        typeof AudioContext !== 'undefined' && typeof AudioContext.prototype.setSinkId === 'function';
      const hasElSink =
        typeof HTMLMediaElement !== 'undefined' &&
        typeof HTMLMediaElement.prototype.setSinkId === 'function';
      sinkEl.textContent = hasCtxSink
        ? 'AudioContext.setSinkId'
        : hasElSink
          ? 'AudioEl.setSinkId'
          : 'No disponible';
    }
    if (permEl) {
      permEl.textContent = appState.audioPermissionGranted ? 'Otorgado' : 'Pendiente';
    }

    if (listEl) {
      if (!appState.outputDevices.length) {
        listEl.innerHTML =
          '<div class="py-1.5 text-amber-300">No se listaron placas adicionales aún. Pulsa "Detectar Placas".</div>';
      } else {
        listEl.innerHTML = '';
        appState.outputDevices.forEach((dev, i) => {
          const row = document.createElement('div');
          row.className = 'py-1.5 flex items-center justify-between gap-2';
          const shortId = dev.deviceId === 'default'
            ? 'default'
            : dev.deviceId
              ? `${dev.deviceId.slice(0, 8)}…`
              : 'sin-id';
          row.innerHTML = `
            <span class="text-slate-200 truncate">${i + 1}. ${dev.label || 'Dispositivo sin etiqueta'}</span>
            <span class="text-slate-400 text-[10px] shrink-0">${shortId}</span>
          `;
          listEl.appendChild(row);
        });
      }
    }
  }

  // =========================================================================
  // ATAJOS DE TECLADO (INCLUYE SHIFT+TECLA FADE INTERACTIVO, Z/X/C Y NUM 1/2/3)
  // =========================================================================
  function handleKeyDown(e) {
    if (isTypingInFormField(e.target)) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      if (appState.contextMenu.isOpen) {
        closeContextMenu();
        return;
      }
      const modals = ['fadesConfigModal', 'audioRoutingModal', 'installWindowsModal'];
      for (const id of modals) {
        const m = document.getElementById(id);
        if (m && !m.classList.contains('hidden')) {
          m.classList.add('hidden');
          return;
        }
      }
      stopAllInChannel('L');
      return;
    }

    if (e.key === 'Backspace') {
      e.preventDefault();
      stopAllInChannel('R');
      return;
    }

    if (e.key === 'PageUp') {
      e.preventDefault();
      stepBankPalette(e.shiftKey ? 'R' : 'L', -1);
      return;
    }
    if (e.key === 'PageDown') {
      e.preventDefault();
      stepBankPalette(e.shiftKey ? 'R' : 'L', 1);
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      adjustBankPlayingBpm(e.shiftKey ? 'R' : 'L', 0.5);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      adjustBankPlayingBpm(e.shiftKey ? 'R' : 'L', -0.5);
      return;
    }

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      seekActivePlayback(-1);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      seekActivePlayback(1);
      return;
    }

    if (e.code === 'NumpadAdd' || e.key === '+') {
      e.preventDefault();
      adjustBankPlayingVolume(e.shiftKey ? 'R' : 'L', 5);
      return;
    }
    if (e.code === 'NumpadSubtract' || e.key === '-') {
      e.preventDefault();
      adjustBankPlayingVolume(e.shiftKey ? 'R' : 'L', -5);
      return;
    }

    if (e.altKey || e.ctrlKey || e.metaKey) return;

    // CUE 1, 2 y 3 del Lado Derecho (R) con teclado numérico: Numpad1, Numpad2, Numpad3
    if (e.code === 'Numpad1') {
      e.preventDefault();
      triggerBankCueSlotByShortcut('R', 0);
      return;
    }
    if (e.code === 'Numpad2') {
      e.preventDefault();
      triggerBankCueSlotByShortcut('R', 1);
      return;
    }
    if (e.code === 'Numpad3') {
      e.preventDefault();
      triggerBankCueSlotByShortcut('R', 2);
      return;
    }

    const rawKey = (e.key || '').toUpperCase();
    const key = rawKey === 'N' && e.code === 'Semicolon' ? 'Ñ' : rawKey;

    // CUE 1, 2 y 3 del Lado Izquierdo (L) con Z, X, C (sin Shift)
    if (!e.shiftKey && (key === 'Z' || key === 'X' || key === 'C')) {
      e.preventDefault();
      const cueIdx = key === 'Z' ? 0 : key === 'X' ? 1 : 2;
      triggerBankCueSlotByShortcut('L', cueIdx);
      return;
    }

    // Teclas de botonera Izquierda (L)
    if (LEFT_KEYS.includes(key)) {
      e.preventDefault();
      const padId = `L-${key}`;
      if (e.shiftKey) {
        triggerInteractiveFadeStop(padId);
        return;
      }
      const pad = appState.pads[padId];
      if (pad && normalizeTriggerMode(pad.triggerMode) === 'sampler') {
        if (e.repeat || appState.heldSamplerKeys.has(padId)) return;
        appState.heldSamplerKeys.add(padId);
      }
      triggerPad(padId);
      return;
    }

    // Teclas de botonera Derecha (R)
    if (RIGHT_KEYS.includes(key)) {
      e.preventDefault();
      const padId = `R-${key}`;
      if (e.shiftKey) {
        triggerInteractiveFadeStop(padId);
        return;
      }
      const pad = appState.pads[padId];
      if (pad && normalizeTriggerMode(pad.triggerMode) === 'sampler') {
        if (e.repeat || appState.heldSamplerKeys.has(padId)) return;
        appState.heldSamplerKeys.add(padId);
      }
      triggerPad(padId);
    }
  }

  function handleKeyUp(e) {
    const rawKey = (e.key || '').toUpperCase();
    const key = rawKey === 'N' && e.code === 'Semicolon' ? 'Ñ' : rawKey;

    if (LEFT_KEYS.includes(key)) {
      const padId = `L-${key}`;
      if (appState.heldSamplerKeys.has(padId)) {
        appState.heldSamplerKeys.delete(padId);
        const pad = appState.pads[padId];
        if (pad && normalizeTriggerMode(pad.triggerMode) === 'sampler') {
          stopPadInstance(pad, false);
        }
      }
    }

    if (RIGHT_KEYS.includes(key)) {
      const padId = `R-${key}`;
      if (appState.heldSamplerKeys.has(padId)) {
        appState.heldSamplerKeys.delete(padId);
        const pad = appState.pads[padId];
        if (pad && normalizeTriggerMode(pad.triggerMode) === 'sampler') {
          stopPadInstance(pad, false);
        }
      }
    }
  }

  // =========================================================================
  // EVENTOS DE INTERFAZ Y CONTROLES
  // =========================================================================
  function setupUIEventListeners() {
    document.getElementById('selectConfigFolderBtn').addEventListener('click', promptSelectConfigFolder);

    document.getElementById('togglePreservePitchBtn').addEventListener('click', () => {
      appState.preservePitch = !appState.preservePitch;
      renderTransitionModeUI();
      saveAllState();
      showToast(
        appState.preservePitch
          ? 'Tono fijo activado: al subir o bajar BPM mantiene la tonalidad real.'
          : 'Tono libre: la tonalidad acompaña al cambio de BPM.',
        'info'
      );
    });

    document.getElementById('toggleTransitionModeBtn').addEventListener('click', () => {
      appState.transition.mode = appState.transition.mode === 'fade' ? 'cut' : 'fade';
      renderTransitionModeUI();
      saveAllState();
      showToast(
        appState.transition.mode === 'fade'
          ? `Modo Fade activado (${appState.transition.fadeInMs}ms In / ${appState.transition.fadeOutMs}ms Out).`
          : 'Modo Corte Automático activado.',
        'info'
      );
    });

    // Apartado global Fades
    const fadesModal = document.getElementById('fadesConfigModal');
    document.getElementById('openFadesModalBtn').addEventListener('click', () => {
      renderTransitionModeUI();
      fadesModal.classList.remove('hidden');
    });
    document.getElementById('closeFadesModalBtn').addEventListener('click', () => {
      fadesModal.classList.add('hidden');
    });
    fadesModal.addEventListener('click', (e) => {
      if (e.target === fadesModal) fadesModal.classList.add('hidden');
    });

    document.getElementById('selectCutModeBtn').addEventListener('click', () => {
      appState.transition.mode = 'cut';
      renderTransitionModeUI();
      saveAllState();
    });
    document.getElementById('selectFadeModeBtn').addEventListener('click', () => {
      appState.transition.mode = 'fade';
      renderTransitionModeUI();
      saveAllState();
    });

    const setFadeIn = (val) => {
      appState.transition.fadeInMs = clamp(Math.round(Number(val) || 0), MIN_FADE_MS, MAX_FADE_MS);
      renderTransitionModeUI();
      saveAllState();
    };
    const setFadeOut = (val) => {
      appState.transition.fadeOutMs = clamp(Math.round(Number(val) || 0), MIN_FADE_MS, MAX_FADE_MS);
      renderTransitionModeUI();
      saveAllState();
    };
    const setInteractiveFade = (val) => {
      appState.transition.interactiveFadeMs = clamp(Math.round(Number(val) || DEFAULT_INTERACTIVE_FADE_MS), 50, 15000);
      renderTransitionModeUI();
      saveAllState();
    };

    document.getElementById('fadeInMsSlider').addEventListener('input', (e) => setFadeIn(e.target.value));
    document.getElementById('fadeInMsInput').addEventListener('change', (e) => setFadeIn(e.target.value));
    document.querySelectorAll('.fade-in-preset').forEach((btn) => {
      btn.addEventListener('click', () => setFadeIn(btn.getAttribute('data-fade-in-preset')));
    });

    document.getElementById('fadeOutMsSlider').addEventListener('input', (e) => setFadeOut(e.target.value));
    document.getElementById('fadeOutMsInput').addEventListener('change', (e) => setFadeOut(e.target.value));
    document.querySelectorAll('.fade-out-preset').forEach((btn) => {
      btn.addEventListener('click', () => setFadeOut(btn.getAttribute('data-fade-out-preset')));
    });

    document.getElementById('interactiveFadeMsSlider').addEventListener('input', (e) => setInteractiveFade(e.target.value));
    document.getElementById('interactiveFadeMsInput').addEventListener('change', (e) => setInteractiveFade(e.target.value));
    document.querySelectorAll('.interactive-fade-preset').forEach((btn) => {
      btn.addEventListener('click', () => setInteractiveFade(btn.getAttribute('data-interactive-fade-preset')));
    });

    document.getElementById('selectedBpmDownBtn').addEventListener('click', (e) => adjustBankPlayingBpm(e.shiftKey ? 'R' : 'L', -0.5));
    document.getElementById('selectedBpmUpBtn').addEventListener('click', (e) => adjustBankPlayingBpm(e.shiftKey ? 'R' : 'L', 0.5));
    document.getElementById('selectedBpmBadge').addEventListener('click', () => {
      const target = findActivePlayingPad() || appState.pads[appState.selectedPadId] || appState.pads['L-1'];
      if (target) {
        setPadBpm(target.id, target.detectedBpm || DEFAULT_BPM, true, target);
      }
    });

    // Limitador central
    const applySharedLimiterDb = (rawDb) => {
      const cleanDb = clamp(Number(rawDb ?? DEFAULT_LIMITER_DB), MIN_LIMITER_DB, MAX_LIMITER_DB);
      appState.limiter.thresholdDb = cleanDb;
      appState.limiter.thresholdDbL = cleanDb;
      appState.limiter.thresholdDbR = cleanDb;
      renderLimiterUI();
    };

    const limCbL = document.getElementById('limiterEnabledCheckbox-L');
    const limCbR = document.getElementById('limiterEnabledCheckbox-R');
    if (limCbL) {
      limCbL.addEventListener('change', (e) => {
        appState.limiter.enabledL = Boolean(e.target.checked);
        appState.limiter.enabled = Boolean(appState.limiter.enabledL || appState.limiter.enabledR);
        renderLimiterUI();
        saveAllState();
      });
    }
    if (limCbR) {
      limCbR.addEventListener('change', (e) => {
        appState.limiter.enabledR = Boolean(e.target.checked);
        appState.limiter.enabled = Boolean(appState.limiter.enabledL || appState.limiter.enabledR);
        renderLimiterUI();
        saveAllState();
      });
    }

    document.getElementById('limiterThresholdSlider').addEventListener('input', (e) => applySharedLimiterDb(e.target.value));
    document.getElementById('limiterThresholdNumber').addEventListener('change', (e) => applySharedLimiterDb(e.target.value));
    document.getElementById('saveLimiterBtn').addEventListener('click', () => {
      applySharedLimiterDb(document.getElementById('limiterThresholdNumber').value);
      saveAllState();
      showToast(
        `Limitadores guardados (L: ${appState.limiter.enabledL ? appState.limiter.thresholdDbL + ' dB' : 'OFF'} · R: ${appState.limiter.enabledR ? appState.limiter.thresholdDbR + ' dB' : 'OFF'}).`,
        'success'
      );
    });

    // Gestores de paletas independientes por banco L y R
    ['L', 'R'].forEach((bank) => {
      document.getElementById(`paletteSelect-${bank}`).addEventListener('change', async (e) => {
        await switchBankToPalette(bank, e.target.value, true);
      });

      document.getElementById(`prevPaletteBtn-${bank}`).addEventListener('click', () => stepBankPalette(bank, -1));
      document.getElementById(`nextPaletteBtn-${bank}`).addEventListener('click', () => stepBankPalette(bank, 1));

      document.getElementById(`newPaletteBtn-${bank}`).addEventListener('click', async () => {
        const newName = `Paleta ${appState.palettes.length + 1}`;
        const pal = createPaletteObject(newName, `${bank.toLowerCase()}_${Date.now()}`);
        appState.palettes.push(pal);
        renderPaletteSelectorsUI();
        await switchBankToPalette(bank, pal.id, false);
        showToast(`Paleta "${newName}" creada y disponible en ambos lados.`, 'success');
      });

      document.getElementById(`duplicatePaletteBtn-${bank}`).addEventListener('click', async () => {
        const current = getBankPalette(bank);
        if (!current) return;
        syncRuntimePadsIntoPaletteConfig(bank);

        const copyName = `${current.name} (Copia)`;
        const copyPal = createPaletteObject(copyName, `dup_${Date.now()}`);
        copyPal.fadeMs = current.fadeMs;

        const basePads = createDefaultPadConfigs();
        const allPadIds = Object.keys(basePads);

        for (const padId of allPadIds) {
          const srcCfg = (current.pads && current.pads[padId]) || basePads[padId];
          copyPal.pads[padId] = {
            ...basePads[padId],
            ...srcCfg,
            id: padId
          };

          const oldKey = getPaletteSlotKey(current.id, padId);
          const newKey = getPaletteSlotKey(copyPal.id, padId);
          if (appState.decodedAudioCache[oldKey]) {
            appState.decodedAudioCache[newKey] = appState.decodedAudioCache[oldKey];
            computeWaveformPeaks(newKey, appState.decodedAudioCache[newKey]);
          }
          if (appState.rawAudioCache[oldKey]) {
            appState.rawAudioCache[newKey] = appState.rawAudioCache[oldKey].slice(0);
            createOrRefreshAudioBlobUrl(newKey, appState.rawAudioCache[newKey], srcCfg.fileName || '', true);
          }

          try {
            const dbRec = await loadAudioFromIndexedDB(current.id, padId);
            if (dbRec && dbRec.data) {
              await saveAudioToIndexedDB(copyPal.id, padId, dbRec.data, dbRec.fileName || srcCfg.fileName || 'Audio');
            }
          } catch (_) {}
        }

        const normalizedCopy = normalizePaletteRecord(copyPal, appState.palettes.length);
        appState.palettes.push(normalizedCopy);
        renderPaletteSelectorsUI();
        await switchBankToPalette(bank, normalizedCopy.id, false);
        showToast(`Paleta duplicada como "${copyName}".`, 'success');
      });

      document.getElementById(`renamePaletteBtn-${bank}`).addEventListener('click', () => {
        const pal = getBankPalette(bank);
        const input = document.getElementById(`paletteNameInput-${bank}`);
        if (!pal || !input) return;

        const cleanName = input.value.trim();
        if (!cleanName) {
          showToast('Escribe un nombre válido para la paleta.', 'warning');
          return;
        }
        pal.name = cleanName;
        pal.nombre = cleanName;
        renderPaletteSelectorsUI();
        saveAllState();
        showToast(`Paleta renombrada a "${cleanName}".`, 'success');
      });

      document.getElementById(`deletePaletteBtn-${bank}`).addEventListener('click', async () => {
        if (appState.palettes.length <= 1) {
          showToast('Debe existir al menos una paleta activa.', 'warning');
          return;
        }
        const current = getBankPalette(bank);
        if (!current) return;

        const deletedId = current.id;
        const deletedName = current.name;
        const cachedMap = appState.palettePadsCache[deletedId];
        if (cachedMap) {
          Object.values(cachedMap).forEach((p) => {
            if (p) stopPadInstance(p, true);
          });
          delete appState.palettePadsCache[deletedId];
        }

        appState.palettes = appState.palettes.filter((p) => p.id !== deletedId);
        await deletePaletteAudiosFromIndexedDB(deletedId);

        const fallbackId = appState.palettes[0].id;
        ['L', 'R'].forEach((side) => {
          if (appState.activePaletteByBank[side] === deletedId) {
            appState.activePaletteByBank[side] = fallbackId;
          }
        });

        rebuildBankPadsFromPalette('L', getBankPalette('L'));
        rebuildBankPadsFromPalette('R', getBankPalette('R'));
        renderAllPadGrids();
        renderPaletteSelectorsUI();
        saveAllState();
        await hydrateBankPaletteAudiosFromDB('L', getBankPalette('L'));
        await hydrateBankPaletteAudiosFromDB('R', getBankPalette('R'));
        showToast(`Paleta "${deletedName}" eliminada.`, 'info');
      });

      document.getElementById(`paletteFadeGearBtn-${bank}`).addEventListener('click', () => {
        appState.openFadePanelByBank[bank] = !appState.openFadePanelByBank[bank];
        const panel = document.getElementById(`paletteFadePanel-${bank}`);
        if (panel) panel.classList.toggle('hidden', !appState.openFadePanelByBank[bank]);
      });

      const applyPaletteFade = (rawVal) => {
        const pal = getBankPalette(bank);
        if (!pal) return;
        pal.fadeMs = clamp(Math.round(Number(rawVal) || 0), MIN_FADE_MS, MAX_FADE_MS);
        renderPaletteSelectorsUI();
        saveAllState();
      };

      document.getElementById(`paletteFadeSlider-${bank}`).addEventListener('input', (e) => applyPaletteFade(e.target.value));
      document.getElementById(`paletteFadeNumber-${bank}`).addEventListener('change', (e) => applyPaletteFade(e.target.value));
    });

    setupBankMasterSeekEvents('L');
    setupBankMasterSeekEvents('R');

    document.getElementById('testToneBtn-L').addEventListener('click', () => playTestTone('L'));
    document.getElementById('testToneBtn-R').addEventListener('click', () => playTestTone('R'));
    document.getElementById('modalTestBtn-L').addEventListener('click', () => playTestTone('L'));
    document.getElementById('modalTestBtn-R').addEventListener('click', () => playTestTone('R'));

    document.getElementById('stopBankBtn-L').addEventListener('click', () => stopAllInChannel('L'));
    document.getElementById('stopBankBtn-R').addEventListener('click', () => stopAllInChannel('R'));

    // Modal placas + deslizable 0 a 10 seg en milisegundos
    const audioModal = document.getElementById('audioRoutingModal');
    document.getElementById('openAudioModalBtn').addEventListener('click', async () => {
      renderModalSeekStepUI();
      audioModal.classList.remove('hidden');
      await refreshAudioDevices(false);
    });
    document.getElementById('closeAudioModalBtn').addEventListener('click', () => {
      audioModal.classList.add('hidden');
    });
    audioModal.addEventListener('click', (e) => {
      if (e.target === audioModal) audioModal.classList.add('hidden');
    });
    document.getElementById('detectAudioDevicesBtn').addEventListener('click', async () => {
      await refreshAudioDevices(true);
    });

    document.getElementById('modalSeekStepSlider').addEventListener('input', (e) => setSeekStepMs(e.target.value));
    document.getElementById('modalSeekStepNumber').addEventListener('change', (e) => setSeekStepMs(e.target.value));
    document.querySelectorAll('.modal-seek-preset').forEach((btn) => {
      btn.addEventListener('click', () => setSeekStepMs(btn.getAttribute('data-modal-seek-ms')));
    });

    ['L', 'R'].forEach((bank) => {
      document.getElementById(`deviceSelect-${bank}`).addEventListener('change', async (e) => {
        const deviceId = e.target.value;
        const found = appState.outputDevices.find((d) => d.deviceId === deviceId);
        appState.routing[bank].deviceId = deviceId;
        appState.routing[bank].deviceLabel = found && found.label
          ? found.label
          : deviceId
            ? 'Placa asignada'
            : 'Salida predeterminada';
        appState.engines[bank].sinkDeviceId = '__FORCE_REBIND__';
        await ensureBankEngineReady(bank);
        renderAudioRoutingUI();
        saveAllState();
      });

      document.getElementById(`channelSelect-${bank}`).addEventListener('change', async (e) => {
        appState.routing[bank].channelMode = e.target.value;
        await ensureBankEngineReady(bank);
        renderAudioRoutingUI();
        saveAllState();
      });
    });

    // Modal instalar en Windows
    const installModal = document.getElementById('installWindowsModal');
    document.getElementById('openInstallModalBtn').addEventListener('click', () => {
      installModal.classList.remove('hidden');
    });
    document.getElementById('closeInstallModalBtn').addEventListener('click', () => {
      installModal.classList.add('hidden');
    });
    installModal.addEventListener('click', (e) => {
      if (e.target === installModal) installModal.classList.add('hidden');
    });

    // Menú contextual de botón
    const fileInput = document.getElementById('audioFileInput');
    document.getElementById('ctxLoadAudioBtn').addEventListener('click', () => {
      if (!appState.contextMenu.padId) return;
      const bank = appState.contextMenu.padId.startsWith('L-') ? 'L' : 'R';
      const bankPal = getBankPalette(bank);
      appState.pendingUploadTarget = {
        paletteId: appState.contextMenu.paletteId || (bankPal && bankPal.id),
        padId: appState.contextMenu.padId
      };
      fileInput.value = '';
      fileInput.click();
    });

    document.getElementById('ctxClearAudioBtn').addEventListener('click', async () => {
      if (!appState.contextMenu.padId) return;
      const bank = appState.contextMenu.padId.startsWith('L-') ? 'L' : 'R';
      const bankPal = getBankPalette(bank);
      const targetPalId = appState.contextMenu.paletteId || (bankPal && bankPal.id);
      await clearSinglePadAudio(targetPalId, appState.contextMenu.padId);
    });

    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      const target = appState.pendingUploadTarget;
      appState.pendingUploadTarget = null;
      if (file && target && target.paletteId && target.padId) {
        await assignAudioFileToPad(target.paletteId, target.padId, file);
      }
    });

    document.getElementById('ctxLabelInput').addEventListener('input', (e) => {
      const pad = appState.pads[appState.contextMenu.padId];
      if (!pad) return;
      pad.label = e.target.value.trim() || `${pad.channel} ${formatPadNumber(pad.number)}`;
      renderPadVisuals(pad);
      updateBankMasterProgressBar(pad.channel);
      saveAllState();
    });

    document.getElementById('ctxCustomColorInput').addEventListener('input', (e) => {
      const pad = appState.pads[appState.contextMenu.padId];
      if (!pad) return;
      pad.color = e.target.value;
      renderContextMenuColorSwatches(pad.color);
      renderPadVisuals(pad);
      saveAllState();
    });

    // 3 palomitas de modo de disparo (Normal, Single, Sampler)
    const setContextPadTriggerMode = (newMode) => {
      const pad = appState.pads[appState.contextMenu.padId];
      if (!pad) return;
      pad.triggerMode = normalizeTriggerMode(newMode);
      renderContextMenuTriggerModeUI(pad.triggerMode);
      renderPadVisuals(pad);
      saveAllState();
    };

    document.getElementById('ctxModeNormalChk').addEventListener('change', (e) => {
      setContextPadTriggerMode(e.target.checked ? 'normal' : 'normal');
    });
    document.getElementById('ctxModeSingleChk').addEventListener('change', (e) => {
      setContextPadTriggerMode(e.target.checked ? 'single' : 'normal');
    });
    document.getElementById('ctxModeSamplerChk').addEventListener('change', (e) => {
      setContextPadTriggerMode(e.target.checked ? 'sampler' : 'normal');
    });

    const ctxBucleCheckbox = document.getElementById('ctxBucleCheckbox');
    if (ctxBucleCheckbox) {
      ctxBucleCheckbox.addEventListener('change', (e) => {
        const pad = appState.pads[appState.contextMenu.padId];
        if (!pad) return;
        pad.bucle = Boolean(e.target.checked);
        pad.activeSources.forEach((entry) => {
          try {
            if (entry.mediaEl) {
              entry.mediaEl.loop = pad.bucle;
            }
            if (entry.source && 'loop' in entry.source) {
              entry.source.loop = pad.bucle;
              if (pad.bucle) {
                entry.source.loopStart = getPrimaryCueSeconds(pad);
                entry.source.loopEnd = entry.duration || pad.duration;
              }
            }
          } catch (_) {}
        });
        renderPadVisuals(pad);
        updateBankMasterProgressBar(pad.channel);
        saveAllState();
        showToast(
          pad.bucle
            ? `Bucle ∞ activado en ${pad.label}.`
            : `Bucle ∞ desactivado en ${pad.label}.`,
          'info'
        );
      });
    }

    document.getElementById('ctxVolSlider').addEventListener('input', (e) => {
      const pad = appState.pads[appState.contextMenu.padId];
      if (pad) setPadVolume(pad.id, Number(e.target.value) / 100, true);
    });
    document.getElementById('ctxVolMinusBtn').addEventListener('click', () => {
      const pad = appState.pads[appState.contextMenu.padId];
      if (pad) setPadVolume(pad.id, (Math.round(pad.volume * 100) - 5) / 100, true);
    });
    document.getElementById('ctxVolPlusBtn').addEventListener('click', () => {
      const pad = appState.pads[appState.contextMenu.padId];
      if (pad) setPadVolume(pad.id, (Math.round(pad.volume * 100) + 5) / 100, true);
    });

    document.getElementById('ctxBpmSlider').addEventListener('input', (e) => {
      const pad = appState.pads[appState.contextMenu.padId];
      if (pad) setPadBpm(pad.id, Number(e.target.value), true);
    });
    document.getElementById('ctxBpmMinusBtn').addEventListener('click', () => {
      const pad = appState.pads[appState.contextMenu.padId];
      if (pad) setPadBpm(pad.id, Number(pad.bpm || pad.detectedBpm || DEFAULT_BPM) - 0.5, true);
    });
    document.getElementById('ctxBpmPlusBtn').addEventListener('click', () => {
      const pad = appState.pads[appState.contextMenu.padId];
      if (pad) setPadBpm(pad.id, Number(pad.bpm || pad.detectedBpm || DEFAULT_BPM) + 0.5, true);
    });
    document.getElementById('ctxBpmResetBtn').addEventListener('click', () => {
      const pad = appState.pads[appState.contextMenu.padId];
      if (pad) setPadBpm(pad.id, pad.detectedBpm || DEFAULT_BPM, true);
    });

    // Pestañas CUE 1, 2 y 3 en el menú contextual
    document.querySelectorAll('.ctx-cue-slot-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pad = appState.pads[appState.contextMenu.padId];
        if (!pad) return;
        const slotIdx = Number(btn.getAttribute('data-cue-slot')) || 0;
        selectContextMenuCueSlot(pad, slotIdx);
      });
    });

    document.getElementById('ctxCueSlider').addEventListener('input', async (e) => {
      const pad = appState.pads[appState.contextMenu.padId];
      if (!pad || !pad.audioBuffer) return;
      const val = clamp(Number(e.target.value) || 0, 0, Math.max(0, pad.duration - 0.01));
      document.getElementById('ctxCueNumber').value = val.toFixed(2);
      await startCueLoopPreview(pad, val);
    });

    document.getElementById('ctxCueNumber').addEventListener('input', async (e) => {
      const pad = appState.pads[appState.contextMenu.padId];
      if (!pad || !pad.audioBuffer) return;
      const val = clamp(Number(e.target.value) || 0, 0, Math.max(0, pad.duration - 0.01));
      document.getElementById('ctxCueSlider').value = String(val);
      await startCueLoopPreview(pad, val);
    });

    document.getElementById('ctxCueLoopMsInput').addEventListener('change', async (e) => {
      const pad = appState.pads[appState.contextMenu.padId];
      appState.cueLoopMs = clamp(
        Math.round(Number(e.target.value) || DEFAULT_CUE_LOOP_MS),
        MIN_CUE_LOOP_MS,
        MAX_CUE_LOOP_MS
      );
      e.target.value = String(appState.cueLoopMs);
      saveAllState();
      if (pad && pad.audioBuffer && appState.contextMenu.cueLoopActive) {
        await startCueLoopPreview(pad, appState.contextMenu.cueDraftSeconds);
      }
    });

    document.getElementById('ctxCaptureCurrentPosBtn').addEventListener('click', async () => {
      const pad = appState.pads[appState.contextMenu.padId];
      if (!pad || !pad.audioBuffer) return;
      if (!pad.activeSources.length) {
        showToast('Dispara el botón primero para capturar su posición en vivo.', 'info');
        return;
      }
      const latest = pad.activeSources[pad.activeSources.length - 1];
      const pos = clamp(
        getCurrentEntryPositionSeconds(pad.channel, latest),
        0,
        Math.max(0, pad.duration - 0.01)
      );
      document.getElementById('ctxCueSlider').value = String(pos);
      document.getElementById('ctxCueNumber').value = pos.toFixed(2);
      await startCueLoopPreview(pad, pos);
    });

    document.getElementById('ctxClearSingleCueBtn').addEventListener('click', () => {
      const pad = appState.pads[appState.contextMenu.padId];
      if (!pad) return;
      const slotIdx = appState.contextMenu.activeCueSlot || 0;
      const cues = normalizeCuesArray(pad.cues, pad.cueStart);
      cues[slotIdx] = null;
      pad.cues = cues;
      pad.cueStart = getPrimaryCueSeconds(pad);
      selectContextMenuCueSlot(pad, slotIdx);
      renderPadVisuals(pad);
      saveAllState();
      showToast(`CUE ${slotIdx + 1} eliminado en ${pad.label}.`, 'info');
    });

    document.getElementById('ctxSaveCueBtn').addEventListener('click', () => {
      const pad = appState.pads[appState.contextMenu.padId];
      if (!pad) return;
      const slotIdx = appState.contextMenu.activeCueSlot || 0;
      const maxCue = pad.audioBuffer && pad.duration > 0 ? Math.max(0, pad.duration - 0.01) : 9999;
      const cueVal = clamp(
        Number(document.getElementById('ctxCueNumber').value) || 0,
        0,
        maxCue
      );
      const cues = normalizeCuesArray(pad.cues, pad.cueStart);
      cues[slotIdx] = cueVal;
      pad.cues = cues;
      pad.cueStart = getPrimaryCueSeconds(pad);

      stopCueLoopPreview();
      renderContextMenuCueSlotTabs(pad);
      renderPadVisuals(pad);
      saveAllState();
      showToast(
        `CUE ${slotIdx + 1} guardado en ${pad.label}: ${cueVal.toFixed(2)}s`,
        'success'
      );
    });

    document.getElementById('ctxCloseBtn').addEventListener('click', closeContextMenu);

    document.addEventListener('click', (e) => {
      const menu = document.getElementById('padContextMenu');
      if (appState.contextMenu.isOpen && menu && !menu.contains(e.target)) {
        closeContextMenu();
      }
    });

    if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
      navigator.mediaDevices.addEventListener('devicechange', () => refreshAudioDevices(false));
    }

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
  }

  // =========================================================================
  // INICIALIZACIÓN DE PABLETS BROADCAST
  // =========================================================================
  async function initBroadcastApp() {
    loadSavedState();

    try {
      await openAudioDatabase();
      const restoredHandle = await restoreDirectoryHandleFromDB();
      if (restoredHandle) {
        appState.configDirHandle = restoredHandle;
        await loadConfigFromLocalFolderIfAvailable(restoredHandle);
      }
    } catch (err) {
      console.warn('IndexedDB no disponible:', err);
    }

    updateConfigFolderBadge();

    const bankPalL = getBankPalette('L');
    const bankPalR = getBankPalette('R');
    if (bankPalL) rebuildBankPadsFromPalette('L', bankPalL);
    if (bankPalR) rebuildBankPadsFromPalette('R', bankPalR);

    renderPaletteSelectorsUI();
    renderAllPadGrids();
    renderTransitionModeUI();
    renderModalSeekStepUI();
    renderLimiterUI();
    setupUIEventListeners();
    setupGlobalSongSearch();
    startMasterVuLoop();

    if (bankPalL) await hydrateBankPaletteAudiosFromDB('L', bankPalL);
    if (bankPalR) await hydrateBankPaletteAudiosFromDB('R', bankPalR);
    await refreshAudioDevices(false);

    updateBankMasterProgressBar('L');
    updateBankMasterProgressBar('R');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBroadcastApp);
  } else {
    initBroadcastApp();
  }
})();