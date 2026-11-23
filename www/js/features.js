/* =========================================================
   StudyDeck — features.js
   Sensor / permission features:
     - Motion Lab (accelerometer) + tilt-to-grade gesture
     - Snap & Share (camera + Android share sheet intent)
     - Compass & Study Spots (heading + live GPS)
     - Focus Mode (native foreground service + shake detection)
     - Permission Center
   Runs inside Cordova (Android) and degrades gracefully in a
   normal browser where native pieces are unavailable.
   ========================================================= */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const isCordova = !!window.cordova;
  let native = null; // window.StudyNative (our Cordova plugin) once the device is ready

  const ready = isCordova
    ? new Promise((resolve) => document.addEventListener('deviceready', () => { native = window.StudyNative || null; resolve(); }, { once: true }))
    : Promise.resolve();

  /* ---------------------------------------------------------
     small UI helpers (Ionic alert / loading / banner)
     --------------------------------------------------------- */
  const openAlerts = new Set();
  /** Closes any explanation dialog still open (used when the user leaves a screen). */
  function dismissAlerts() { openAlerts.forEach((a) => { try { a.dismiss(null, 'cancel'); } catch (e) { /* ignore */ } }); }

  function ask(header, message, okText, cancelText) {
    return new Promise((resolve) => {
      const a = document.createElement('ion-alert');
      a.header = header;
      a.message = message;
      a.buttons = [
        { text: cancelText || 'Not now', role: 'cancel' },
        { text: okText || 'Continue', role: 'confirm' }
      ];
      a.addEventListener('didDismiss', (e) => { openAlerts.delete(a); a.remove(); resolve(e.detail.role === 'confirm'); });
      openAlerts.add(a);
      $('app').appendChild(a);
      a.present();
    });
  }

  async function showLoading(message) {
    const l = document.createElement('ion-loading');
    l.message = message;
    l.backdropDismiss = true; // never trap the user
    $('app').appendChild(l);
    try { await l.present(); } catch (e) { /* ignore */ }
    return {
      dismiss() { try { l.dismiss(); } catch (e) { /* ignore */ } setTimeout(() => l.remove(), 400); }
    };
  }

  /** Renders a status banner with optional action buttons. Text is always set with textContent. */
  function setBanner(el, cfg) {
    el.innerHTML = '';
    if (!cfg) { el.className = 'banner hidden'; return; }
    el.className = 'banner banner-' + (cfg.kind || 'info');
    const p = document.createElement('p');
    p.textContent = cfg.text;
    el.appendChild(p);
    (cfg.actions || []).forEach((a) => {
      const b = document.createElement('ion-button');
      b.size = 'small';
      b.shape = 'round';
      b.fill = a.fill || 'solid';
      b.textContent = a.label;
      b.addEventListener('click', a.onClick);
      el.appendChild(b);
    });
  }

  /** Removes markup characters / control characters from user text (defence in depth: we also only
      ever render user text with textContent, never innerHTML). */
  function sanitizeText(value, max) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max || 80);
  }

  /* ---------------------------------------------------------
     Permissions (Android runtime permission model)
       states: granted | prompt (never asked) | denied (can ask again)
               | blocked (permanently denied -> system settings)
     --------------------------------------------------------- */
  const WEB_PERM_NAMES = { camera: 'camera', location: 'geolocation', notifications: 'notifications' };

  async function permCheck(key) {
    await ready;
    if (native) {
      try { return await native.checkPermission(key); } catch (e) { return { state: 'prompt' }; }
    }
    try {
      const r = await navigator.permissions.query({ name: WEB_PERM_NAMES[key] });
      return { state: { granted: 'granted', prompt: 'prompt', denied: 'blocked' }[r.state] || 'prompt', precise: true };
    } catch (e) {
      return { state: 'prompt' };
    }
  }

  async function permRequest(key) {
    await ready;
    if (native) return native.requestPermission(key);
    try {
      if (key === 'camera') {
        const s = await navigator.mediaDevices.getUserMedia({ video: true });
        s.getTracks().forEach((t) => t.stop());
      } else if (key === 'location') {
        await new Promise((r) => navigator.geolocation.getCurrentPosition(r, r, { timeout: 8000 }));
      } else if (key === 'notifications' && window.Notification) {
        await Notification.requestPermission();
      }
    } catch (e) { /* the result is read back below */ }
    return permCheck(key);
  }

  async function openAppSettings() {
    await ready;
    if (native) native.openAppSettings();
    else showToast('Change this in your browser’s site settings.');
  }

  /** Explains why a permission is needed, then asks - in context, at the moment of first use. */
  async function ensurePermission(key, explain) {
    const info = await permCheck(key);
    if (info.state === 'granted' || info.state === 'blocked') return info;
    const ok = await ask(explain.title, explain.message, 'Continue', 'Not now');
    if (!ok) return Object.assign({}, info, { declined: true });
    return permRequest(key);
  }

  /** Banner for a permission that is not usable. `retry` re-runs the feature. */
  function permissionBanner(el, info, featureName, key, retry) {
    if (info.state === 'blocked') {
      setBanner(el, {
        kind: 'danger',
        text: featureName + ' is turned off because the permission was permanently denied. Open Android settings → Permissions to enable it.',
        actions: [{ label: 'Open settings', onClick: openAppSettings }]
      });
    } else {
      setBanner(el, {
        kind: 'warn',
        text: featureName + ' needs the ' + key + ' permission. Nothing is shared until you allow it.',
        actions: [{ label: 'Allow ' + key, onClick: retry }]
      });
    }
  }

  /* ---------------------------------------------------------
     Motion engine (devicemotion): shared by Motion Lab + study tilt
     --------------------------------------------------------- */
  const Tilt = (function () {
    const subs = new Set();
    let attached = false;

    function screenAngle() {
      if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
      return typeof window.orientation === 'number' ? window.orientation : 0;
    }
    // device axes -> screen axes (accelerometer values are reported in the device's natural orientation)
    function toScreen(x, y) {
      switch (((screenAngle() % 360) + 360) % 360) {
        case 90: return { sx: -y, sy: x };
        case 180: return { sx: -x, sy: -y };
        case 270: return { sx: y, sy: -x };
        default: return { sx: x, sy: y };
      }
    }
    function invert() { return !!loadData('studydeck_tilt_invert', false); }

    function onMotion(e) {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null || a.y == null || a.z == null) return;
      const s = toScreen(a.x, a.y);
      // Sideways inclination of the screen's x axis against gravity. Positive = right edge down.
      let roll = Math.atan2(-s.sx, Math.sqrt(s.sy * s.sy + a.z * a.z)) * 180 / Math.PI;
      if (invert()) roll = -roll;
      const sample = { x: a.x, y: a.y, z: a.z, roll: roll, t: Date.now() };
      subs.forEach((fn) => fn(sample));
    }

    return {
      async subscribe(fn) {
        // iOS Safari style permission gate (not needed on Android WebView)
        if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === 'function') {
          const r = await DeviceMotionEvent.requestPermission();
          if (r !== 'granted') throw new Error('denied');
        }
        subs.add(fn);
        if (!attached) { window.addEventListener('devicemotion', onMotion); attached = true; }
      },
      unsubscribe(fn) {
        subs.delete(fn);
        if (!subs.size && attached) { window.removeEventListener('devicemotion', onMotion); attached = false; }
      },
      get active() { return attached; }
    };
  })();

  /* ---------------------------------------------------------
     Motion Lab
     --------------------------------------------------------- */
  const Motion = (function () {
    let running = false;
    let latest = null;
    let raf = 0;
    let watchdog = 0;
    let gotData = false;

    const clamp01 = (v) => Math.max(0, Math.min(1, v));

    function paint() {
      raf = 0;
      if (!latest) return;
      $('axis-x').textContent = latest.x.toFixed(2);
      $('axis-y').textContent = latest.y.toFixed(2);
      $('axis-z').textContent = latest.z.toFixed(2);
      $('bar-x').value = clamp01((latest.x + 20) / 40);
      $('bar-y').value = clamp01((latest.y + 20) / 40);
      $('bar-z').value = clamp01((latest.z + 20) / 40);

      const roll = latest.roll;
      $('tilt-angle').textContent = Math.round(roll) + '°';
      $('tilt-needle').style.left = (50 + Math.max(-90, Math.min(90, roll)) / 90 * 50) + '%';
      const verdict = $('tilt-verdict');
      if (roll <= -45) { verdict.textContent = 'Still learning ←'; verdict.className = 'tilt-verdict v-learning'; }
      else if (roll >= 45) { verdict.textContent = '→ I know it'; verdict.className = 'tilt-verdict v-know'; }
      else { verdict.textContent = 'Neutral — tilt left or right about 45°'; verdict.className = 'tilt-verdict'; }
    }

    function onSample(s) {
      gotData = true;
      latest = s;
      if (!raf) raf = requestAnimationFrame(paint);
    }

    function setUi(on) {
      const chip = $('motion-status');
      chip.textContent = on ? 'Listening to accelerometer' : 'Stopped';
      chip.color = on ? 'success' : 'medium';
      $('motion-start').disabled = on;
      $('motion-stop').disabled = !on;
    }

    async function start() {
      if (running) return;
      setBanner($('motion-error'), null);
      $('motion-error').classList.add('hidden');
      try {
        await Tilt.subscribe(onSample);
      } catch (e) {
        showError('Motion access was denied. Allow motion sensors for this site and try again.');
        return;
      }
      running = true;
      gotData = false;
      setUi(true);
      watchdog = setTimeout(() => {
        if (running && !gotData) showError('No accelerometer data is coming in. This device or browser may not expose motion sensors.');
      }, 2000);
    }

    function stop() {
      if (!running) { setUi(false); return; }
      Tilt.unsubscribe(onSample);       // really stops listening to the sensor
      running = false;
      clearTimeout(watchdog);
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      setUi(false);
    }

    function showError(msg) {
      const el = $('motion-error');
      el.textContent = msg;
      el.classList.remove('hidden');
    }

    function wire() {
      $('motion-start').addEventListener('click', start);
      $('motion-stop').addEventListener('click', stop);
      const inv = $('tilt-invert');
      inv.checked = !!loadData('studydeck_tilt_invert', false);
      inv.addEventListener('ionChange', (e) => saveData('studydeck_tilt_invert', !!e.detail.checked));
      setUi(false);
    }

    return { wire, start, stop };
  })();

  /* ---------------------------------------------------------
     Tilt-to-grade while studying a deck
     --------------------------------------------------------- */
  const StudyTilt = (function () {
    const TRIGGER_DEG = 45;
    const RESET_DEG = 20;
    const HOLD_MS = 300;
    let on = false;
    let armed = false;
    let dir = 0;
    let since = 0;

    function onSample(s) {
      if (Math.abs(s.roll) < RESET_DEG) { armed = true; dir = 0; return; }
      if (!armed) return;
      const flipped = $('flash-card').classList.contains('flipped');
      if (!flipped) return;                                  // grade only after the answer is shown
      const d = s.roll <= -TRIGGER_DEG ? -1 : (s.roll >= TRIGGER_DEG ? 1 : 0);
      if (d === 0) { dir = 0; return; }
      if (d !== dir) { dir = d; since = s.t; return; }
      if (s.t - since >= HOLD_MS) {
        armed = false;                                       // one tilt = one grade
        dir = 0;
        if (navigator.vibrate) navigator.vibrate(60);
        showToast(d === 1 ? 'I knew it →' : '← Still learning');
        gradeCard(d === 1);
      }
    }

    async function begin() {
      if (on) return;
      try {
        await Tilt.subscribe(onSample);
        on = true; armed = false; dir = 0;
      } catch (e) {
        $('study-tilt').checked = false;
        showToast('Motion sensors are not available.');
      }
    }
    function end() {
      if (!on) return;
      Tilt.unsubscribe(onSample);
      on = false;
    }

    function wire() {
      const t = $('study-tilt');
      t.checked = !!loadData('studydeck_tilt_study', false);
      $('study-tilt-hint').classList.toggle('hidden', !t.checked);
      t.addEventListener('ionChange', (e) => {
        saveData('studydeck_tilt_study', !!e.detail.checked);
        $('study-tilt-hint').classList.toggle('hidden', !e.detail.checked);
        if (e.detail.checked) begin(); else end();
      });
    }

    return {
      wire,
      enter() { if ($('study-tilt').checked) begin(); },
      leave: end
    };
  })();

  /* ---------------------------------------------------------
     Snap & Share
     --------------------------------------------------------- */
  const Snap = (function () {
    let photo = null; // base64 JPEG, in memory only

    function showPhoto() {
      const img = $('photo-img');
      if (photo) {
        img.src = 'data:image/jpeg;base64,' + photo;
        img.classList.remove('hidden');
        $('photo-placeholder').classList.add('hidden');
      } else {
        img.removeAttribute('src');
        img.classList.add('hidden');
        $('photo-placeholder').classList.remove('hidden');
      }
      $('photo-share').disabled = !photo;
      $('photo-clear').disabled = !photo;
    }

    function capture() {
      return new Promise((resolve, reject) => {
        if (!navigator.camera) {                              // browser fallback
          const input = document.createElement('input');
          input.type = 'file'; input.accept = 'image/*'; input.capture = 'environment';
          input.onchange = () => {
            const f = input.files && input.files[0];
            if (!f) { reject('cancelled'); return; }
            const r = new FileReader();
            r.onload = () => resolve(String(r.result).split(',')[1]);
            r.onerror = () => reject('read');
            r.readAsDataURL(f);
          };
          input.addEventListener('cancel', () => reject('cancelled'));
          input.click();
          return;
        }
        navigator.camera.getPicture(resolve, reject, {
          quality: 80,
          destinationType: Camera.DestinationType.DATA_URL,
          sourceType: Camera.PictureSourceType.CAMERA,
          encodingType: Camera.EncodingType.JPEG,
          correctOrientation: true,
          targetWidth: 1600,
          targetHeight: 1600,
          saveToPhotoAlbum: false
        });
      });
    }

    async function take() {
      setBanner($('photo-banner'), null);
      const info = await ensurePermission('camera', {
        title: 'Use the camera?',
        message: 'StudyDeck needs the camera to take a photo of your notes. The photo stays on your phone unless you choose to share it.'
      });
      if (info.state !== 'granted') {
        if (info.declined) showToast('Camera permission was not requested.');
        permissionBanner($('photo-banner'), info, 'Taking photos', 'camera', take);
        return;
      }
      const loading = await showLoading('Opening camera…');
      try {
        photo = await capture();
        showPhoto();
      } catch (err) {
        const after = await permCheck('camera');           // permission revoked meanwhile?
        if (after.state !== 'granted') permissionBanner($('photo-banner'), after, 'Taking photos', 'camera', take);
        else showToast('Camera closed — no photo was taken.');
      } finally {
        loading.dismiss();
      }
    }

    async function share() {
      if (!photo) return;
      const caption = sanitizeText($('photo-caption').value, 80);
      await ready;
      const loading = await showLoading('Preparing photo…');
      try {
        if (native) {
          await native.shareImage(photo, caption);          // hands over to the Android share sheet
        } else if (navigator.share) {
          const bytes = Uint8Array.from(atob(photo), (c) => c.charCodeAt(0));
          const file = new File([bytes], 'studydeck.jpg', { type: 'image/jpeg' });
          await navigator.share({ files: [file], text: caption });
        } else {
          showToast('Sharing needs the Android app or a browser with share support.');
        }
      } catch (e) {
        if (!(e && e.name === 'AbortError')) showToast('Could not open the share sheet.');
      } finally {
        loading.dismiss();
      }
    }

    function wire() {
      $('photo-take').addEventListener('click', take);
      $('photo-share').addEventListener('click', share);
      $('photo-clear').addEventListener('click', () => { photo = null; showPhoto(); $('photo-caption').value = ''; updateCaption(); });
      $('photo-caption').addEventListener('ionInput', updateCaption);
      showPhoto();
    }
    function updateCaption() {
      const v = sanitizeText($('photo-caption').value, 80);
      const el = $('photo-caption-view');
      el.textContent = v;                                    // textContent: user text is never parsed as HTML
      el.classList.toggle('hidden', !v);
    }

    return {
      wire,
      async revalidate() {
        const i = await permCheck('camera');
        if (i.state === 'granted') setBanner($('photo-banner'), null);
      },
      leave() { setBanner($('photo-banner'), null); }
    };
  })();

  /* ---------------------------------------------------------
     Compass & Study Spots
     --------------------------------------------------------- */
  const Compass = (function () {
    const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    let orientHandler = null;
    let orientTimer = 0;
    let gotHeading = false;
    let smooth = null;
    let rafH = 0;
    let headingNow = 0;

    let watchId = null;
    let loading = null;
    let lastPos = null;
    let starting = false;

    /* ----- heading ----- */
    function screenAngle() {
      return (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (window.orientation || 0);
    }
    // W3C example: tilt-compensated compass heading from alpha/beta/gamma
    function compassHeading(alpha, beta, gamma) {
      const d = Math.PI / 180;
      const x = beta * d, y = gamma * d, z = alpha * d;
      const cY = Math.cos(y), cZ = Math.cos(z), sX = Math.sin(x), sY = Math.sin(y), sZ = Math.sin(z);
      const Vx = -cZ * sY - sZ * sX * cY;
      const Vy = -sZ * sY + cZ * sX * cY;
      let h = Math.atan(Vx / Vy);
      if (Vy < 0) h += Math.PI; else if (Vx < 0) h += 2 * Math.PI;
      return h * 180 / Math.PI;
    }
    function paintHeading() {
      rafH = 0;
      const h = headingNow;
      $('heading-deg').textContent = Math.round(h) + '°';
      $('heading-dir').textContent = DIRS[Math.round(h / 45) % 8];
      $('compass-dial').style.transform = 'rotate(' + (-h) + 'deg)';
    }
    function onOrient(e) {
      if (e.alpha == null || e.beta == null || e.gamma == null) return;
      let h = compassHeading(e.alpha, e.beta, e.gamma);
      if (isNaN(h)) return;
      h = (h + screenAngle() + 360) % 360;
      gotHeading = true;
      if (smooth === null) smooth = h;
      else { const diff = ((h - smooth + 540) % 360) - 180; smooth = (smooth + diff * 0.25 + 360) % 360; }
      headingNow = smooth;
      if (!rafH) rafH = requestAnimationFrame(paintHeading);
    }
    function startHeading() {
      stopHeading();
      gotHeading = false; smooth = null;
      orientHandler = onOrient;
      window.addEventListener('deviceorientationabsolute', orientHandler);
      orientTimer = setTimeout(() => {
        if (!gotHeading) {
          $('heading-deg').textContent = 'N/A';
          $('heading-dir').textContent = 'No compass sensor';
        }
      }, 2500);
    }
    function stopHeading() {
      if (orientHandler) window.removeEventListener('deviceorientationabsolute', orientHandler);
      orientHandler = null;
      clearTimeout(orientTimer);
      if (rafH) { cancelAnimationFrame(rafH); rafH = 0; }
    }

    /* ----- location ----- */
    function fmt(n, d) { return (typeof n === 'number' && isFinite(n)) ? n.toFixed(d) : '--'; }
    function paintPos(pos) {
      $('pos-lat').textContent = fmt(pos.coords.latitude, 5) + '°';
      $('pos-lon').textContent = fmt(pos.coords.longitude, 5) + '°';
      $('pos-acc').textContent = '±' + fmt(pos.coords.accuracy, 0) + ' m';
    }
    function clearPos() {
      lastPos = null;
      ['pos-lat', 'pos-lon', 'pos-acc'].forEach((id) => { $(id).textContent = '--'; });
      $('spot-save').disabled = true;
    }
    function stopLocation() {
      if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
      watchId = null;
      if (loading) { loading.dismiss(); loading = null; }
    }

    async function locationServicesOn() {
      await ready;
      if (!native) return true;
      try { return !!(await native.isLocationEnabled()); } catch (e) { return true; }
    }

    async function showPermissionProblem(info) {
      const el = $('compass-banner');
      permissionBanner(el, info, 'Your position', 'location', start);
      $('compass-retry').classList.add('hidden');
    }

    async function onGeoError(err) {
      if (loading) { loading.dismiss(); loading = null; }
      if (err.code === 1) {                                   // PERMISSION_DENIED (also when revoked while running)
        stopLocation(); clearPos();
        showPermissionProblem(await permCheck('location'));
      } else if (err.code === 2) {                            // POSITION_UNAVAILABLE
        if (!(await locationServicesOn())) {
          stopLocation(); clearPos();
          setBanner($('compass-banner'), {
            kind: 'warn',
            text: 'Location services are switched off on this device. Turn them on to see your position.',
            actions: [{ label: 'Open location settings', onClick: async () => { await ready; if (native) native.openLocationSettings(); } },
                      { label: 'Try again', fill: 'outline', onClick: start }]
          });
        } else {
          setBanner($('compass-banner'), { kind: 'info', text: 'Your position is temporarily unavailable. Still trying…' });
        }
      } else if (!lastPos) {                                  // TIMEOUT before the first fix
        setBanner($('compass-banner'), { kind: 'info', text: 'No GPS fix yet. Move near a window or outside — we keep trying.' });
      }
    }

    async function start() {
      if (starting) return;
      starting = true;
      try {
        stopLocation();
        setBanner($('compass-banner'), null);
        const info = await ensurePermission('location', {
          title: 'Use your location?',
          message: 'StudyDeck uses your precise location to show where you are and to tag study spots. It is only read while this screen is open and is never sent anywhere.'
        });
        if (info.state !== 'granted') { clearPos(); showPermissionProblem(info); return; }
        if (!(await locationServicesOn())) {
          clearPos();
          setBanner($('compass-banner'), {
            kind: 'warn',
            text: 'Location services are switched off on this device. Turn them on to see your position.',
            actions: [{ label: 'Open location settings', onClick: async () => { await ready; if (native) native.openLocationSettings(); } },
                      { label: 'Try again', fill: 'outline', onClick: start }]
          });
          return;
        }
        if (!navigator.geolocation) {
          setBanner($('compass-banner'), { kind: 'danger', text: 'This device does not provide location.' });
          return;
        }
        loading = await showLoading('Waiting for the first GPS fix…');
        const myLoading = loading;
        setTimeout(() => { if (loading === myLoading) { myLoading.dismiss(); loading = null; } }, 30000);
        watchId = navigator.geolocation.watchPosition(
          (pos) => {
            lastPos = pos;
            if (loading) { loading.dismiss(); loading = null; }
            setBanner($('compass-banner'), null);
            paintPos(pos);
            $('spot-save').disabled = false;
          },
          onGeoError,
          { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 }
        );
      } finally {
        starting = false;
      }
    }

    /* ----- study spots ----- */
    function spotsKey() { return scopedKey(STORAGE_KEYS.spots); }
    function getSpots() { return loadData(spotsKey(), []); }

    function renderSpots() {
      const list = $('spot-list');
      list.innerHTML = '';
      const spots = getSpots();
      $('spot-empty').classList.toggle('hidden', spots.length > 0);
      spots.forEach((s) => {
        const item = document.createElement('ion-item');
        const label = document.createElement('ion-label');
        const h = document.createElement('h3');
        h.textContent = s.label;                              // never innerHTML
        const p = document.createElement('p');
        p.textContent = fmt(s.lat, 5) + ', ' + fmt(s.lon, 5) + ' · ' + new Date(s.ts).toLocaleString();
        label.appendChild(h); label.appendChild(p);
        const del = document.createElement('ion-button');
        del.slot = 'end'; del.fill = 'clear'; del.color = 'danger';
        const ic = document.createElement('ion-icon');
        ic.slot = 'icon-only'; ic.name = 'trash-outline';
        del.appendChild(ic);
        del.addEventListener('click', () => {
          saveData(spotsKey(), getSpots().filter((x) => x.id !== s.id));
          renderSpots();
        });
        item.appendChild(label); item.appendChild(del);
        list.appendChild(item);
      });
    }

    function saveSpot() {
      if (!lastPos) { showToast('Waiting for a GPS fix first.'); return; }
      const label = sanitizeText($('spot-label').value, 40) || 'Study spot';
      const spots = getSpots();
      spots.unshift({
        id: uid('spot'),
        label: label,
        lat: Math.round(lastPos.coords.latitude * 1e5) / 1e5,
        lon: Math.round(lastPos.coords.longitude * 1e5) / 1e5,
        acc: Math.round(lastPos.coords.accuracy),
        ts: Date.now()
      });
      saveData(spotsKey(), spots.slice(0, 50));
      $('spot-label').value = '';
      renderSpots();
      showToast('Study spot saved');
    }

    function wire() {
      $('spot-save').addEventListener('click', saveSpot);
      $('compass-retry').addEventListener('click', start);
      renderSpots();
    }

    return {
      wire,
      enter() { clearPos(); startHeading(); renderSpots(); start(); },
      leave() { stopHeading(); stopLocation(); setBanner($('compass-banner'), null); },     // stop listening when not needed
      resume() { if (!watchId && !starting) start(); else permCheck('location').then((i) => { if (i.state !== 'granted') { stopLocation(); clearPos(); showPermissionProblem(i); } }); }
    };
  })();

  /* ---------------------------------------------------------
     Focus Mode: native foreground service + shake history
     --------------------------------------------------------- */
  const Focus = (function () {
    let running = false;

    function setRunning(on) {
      running = on;
      const chip = $('svc-status');
      chip.textContent = on ? 'Service running' : 'Service stopped';
      chip.color = on ? 'success' : 'medium';
      $('svc-start').disabled = on;
      $('svc-stop').disabled = !on;
    }

    function renderHistory(list) {
      const ul = $('shake-list');
      ul.innerHTML = '';
      $('shake-empty').classList.toggle('hidden', list.length > 0);
      list.forEach((e) => {
        const item = document.createElement('ion-item');
        const ic = document.createElement('ion-icon');
        ic.slot = 'start'; ic.name = 'pulse';
        const label = document.createElement('ion-label');
        const h = document.createElement('h3');
        h.textContent = 'Study marker';
        const p = document.createElement('p');
        p.textContent = new Date(e.ts).toLocaleString() + ' · ' + e.g + ' g' + (e.background ? ' · app was in background' : '');
        label.appendChild(h); label.appendChild(p);
        item.appendChild(ic); item.appendChild(label);
        ul.appendChild(item);
      });
    }

    async function refresh() {
      await ready;
      if (!native) {
        setRunning(false);
        $('svc-start').disabled = true;
        setBanner($('svc-banner'), { kind: 'info', text: 'Focus Mode uses a real Android service, so it only works in the installed Android app (APK).' });
        renderHistory([]);
        return;
      }
      try {
        setRunning(!!(await native.isServiceRunning()));
        $('shake-sens').value = await native.getSensitivity();
        renderHistory(await native.getHistory());
        const n = await permCheck('notifications');
        if (running && n.state !== 'granted') {
          setBanner($('svc-banner'), { kind: 'warn', text: 'Notification permission was removed, so Android may hide the Focus Mode notification. Stop the service and re-enable notifications.', actions: [{ label: 'Open settings', onClick: openAppSettings }] });
        } else if (!running) {
          setBanner($('svc-banner'), null);
        }
      } catch (e) {
        setBanner($('svc-banner'), { kind: 'danger', text: 'Could not talk to the Focus Mode service.' });
      }
    }

    async function start() {
      await ready;
      if (!native) return;
      setBanner($('svc-banner'), null);
      const info = await ensurePermission('notifications', {
        title: 'Show a notification?',
        message: 'Android requires a visible notification for anything that keeps running in the background. StudyDeck uses it to show Focus Mode is on and to let you stop it. It never shows personal information.'
      });
      if (info.state !== 'granted') {
        permissionBanner($('svc-banner'), info, 'Focus Mode', 'notifications', start);
        return;
      }
      const loading = await showLoading('Starting Focus Mode…');
      try {
        await native.startService();
        for (let i = 0; i < 10 && !running; i++) {            // wait for the service to confirm
          await new Promise((r) => setTimeout(r, 250));
          setRunning(!!(await native.isServiceRunning()));
        }
        if (!running) setBanner($('svc-banner'), { kind: 'danger', text: 'The service did not start. Please try again.' });
      } catch (e) {
        if (String(e).indexOf('NOTIFICATION_PERMISSION') >= 0) permissionBanner($('svc-banner'), await permCheck('notifications'), 'Focus Mode', 'notifications', start);
        else setBanner($('svc-banner'), { kind: 'danger', text: 'The service could not start on this device.' });
      } finally {
        loading.dismiss();
      }
    }

    async function stop() {
      await ready;
      if (!native) return;
      try { await native.stopService(); } catch (e) { /* ignore */ }
      setTimeout(async () => { setRunning(!!(await native.isServiceRunning())); }, 300);
    }

    async function wire() {
      $('svc-start').addEventListener('click', start);
      $('svc-stop').addEventListener('click', stop);
      $('shake-clear').addEventListener('click', async () => {
        await ready;
        if (!native) return;
        if (await ask('Clear markers?', 'All saved study markers will be deleted.', 'Clear', 'Cancel')) {
          await native.clearHistory();
          renderHistory([]);
        }
      });
      $('shake-sens').addEventListener('ionChange', async (e) => {
        await ready;
        if (native) native.setSensitivity(Number(e.detail.value));
      });
      setRunning(false);

      await ready;
      if (native) {
        native.onEvent((ev) => {
          if (!ev) return;
          if (ev.type === 'service') setRunning(!!ev.running);
          if (ev.type === 'shake') {
            if (state.currentPage === 'shake') { refresh(); showToast('Shake detected — marker saved'); }
          }
        });
      }
    }

    return { wire, refresh, resume() { if (state.currentPage === 'shake') refresh(); } };
  })();

  /* ---------------------------------------------------------
     Permission Center
     --------------------------------------------------------- */
  const PermissionCenter = (function () {
    const REQUESTABLE = [
      { key: 'camera', icon: 'camera', title: 'Camera', feature: 'Snap & Share', why: 'Take a photo of your notes. Asked when you tap “Take photo”. If denied, you can still use every other feature.' },
      { key: 'location', icon: 'location', title: 'Location (precise)', feature: 'Compass & Study Spots', why: 'Show your position and tag study spots. Precise location is used so a library and the café next door can be told apart. Asked when you open the Compass.' },
      { key: 'notifications', icon: 'notifications', title: 'Notifications', feature: 'Focus Mode', why: 'Android requires a visible notification for the background service. Asked when you start Focus Mode.' }
    ];
    const NOT_REQUIRED = [
      { icon: 'speedometer', title: 'Accelerometer', feature: 'Motion Lab, tilt to grade, shake', why: 'Motion sensors at normal speed need no permission.' },
      { icon: 'compass', title: 'Magnetometer (compass heading)', feature: 'Compass', why: 'Orientation sensors need no permission.' },
      { icon: 'phone-portrait', title: 'Vibration', feature: 'Focus Mode', why: 'A normal permission granted at install; it shows no prompt.' },
      { icon: 'layers', title: 'Foreground service', feature: 'Focus Mode', why: 'Normal permissions granted at install. The service always shows a notification and you can stop it any time.' }
    ];
    const LABELS = { granted: 'Granted', prompt: 'Not requested yet', denied: 'Denied', blocked: 'Permanently denied' };
    const COLORS = { granted: 'success', prompt: 'medium', denied: 'warning', blocked: 'danger' };

    function row(def, info) {
      const item = document.createElement('ion-item');
      const ic = document.createElement('ion-icon');
      ic.slot = 'start'; ic.name = def.icon;
      const label = document.createElement('ion-label');
      label.className = 'ion-text-wrap';
      const h = document.createElement('h3'); h.textContent = def.title;
      const f = document.createElement('p'); f.textContent = 'Used by: ' + def.feature;
      const w = document.createElement('p'); w.textContent = def.why;
      label.appendChild(h); label.appendChild(f); label.appendChild(w);
      const side = document.createElement('div');
      side.className = 'perm-side';
      const badge = document.createElement('ion-badge');
      if (info) {
        let text = LABELS[info.state] || info.state;
        if (def.key === 'location' && info.state === 'granted' && info.precise === false) text = 'Granted (approximate)';
        badge.textContent = text; badge.color = COLORS[info.state] || 'medium';
      } else {
        badge.textContent = 'No permission needed'; badge.color = 'tertiary';
      }
      side.appendChild(badge);

      if (info && info.state !== 'granted') {
        const b = document.createElement('ion-button');
        b.size = 'small'; b.shape = 'round';
        if (info.state === 'blocked') {
          b.textContent = 'Open settings';
          b.addEventListener('click', openAppSettings);
        } else {
          b.textContent = 'Allow';
          b.addEventListener('click', async () => { await permRequest(def.key); render(); });
        }
        side.appendChild(b);
      } else if (info && info.state === 'granted') {
        const b = document.createElement('ion-button');
        b.size = 'small'; b.fill = 'clear';
        b.textContent = 'Manage';
        b.addEventListener('click', openAppSettings);
        side.appendChild(b);
      }
      label.appendChild(side);
      item.appendChild(ic); item.appendChild(label);
      return item;
    }

    async function render() {
      const list = $('perm-list');
      const infos = await Promise.all(REQUESTABLE.map((d) => permCheck(d.key)));
      list.innerHTML = '';
      REQUESTABLE.forEach((d, i) => list.appendChild(row(d, infos[i])));
      NOT_REQUIRED.forEach((d) => list.appendChild(row(d, null)));
    }

    return { render, resume() { if (state.currentPage === 'permissions') render(); } };
  })();

  /* ---------------------------------------------------------
     lifecycle glue
     --------------------------------------------------------- */
  function onResume() {
    PermissionCenter.resume();
    Focus.resume();
    if (state.currentPage === 'compass') Compass.resume();
    if (state.currentPage === 'snap') Snap.revalidate();
  }

  window.Features = {
    init() {
      Motion.wire();
      StudyTilt.wire();
      Snap.wire();
      Compass.wire();
      Focus.wire();
      document.addEventListener('resume', onResume);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) onResume(); });
      // Rotating the phone must not leave a sensor listener in a broken state.
      window.addEventListener('orientationchange', () => { /* listeners read the screen angle on every event */ });
    },

    onNavigate(from, to) {
      dismissAlerts();
      if (from === 'motion') Motion.stop();
      if (from === 'snap') Snap.leave();
      if (from === 'compass') Compass.leave();
      if (from === 'study') StudyTilt.leave();

      if (to === 'permissions') PermissionCenter.render();
      if (to === 'shake') Focus.refresh();
      if (to === 'compass') Compass.enter();
      if (to === 'study') StudyTilt.enter();
    }
  };
})();
