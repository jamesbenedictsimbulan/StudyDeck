# StudyDeck
**Learn Smarter, One Card at a Time.**

An Ionic flashcard study application. The website and the Android app are built
from **one shared codebase** — the `www/` folder — following the required workflow:

```
Ionic Web Application  →  Build  →  Cordova  →  Android APK
```

---

## 1. Project structure

```
studydeck/
├── config.xml            ← Cordova project config (Android platform, icons, permissions)
├── package.json           ← npm scripts + Cordova dependency
├── res/icon/android/       ← app icons used by the Android build
└── www/                    ← THE SHARED CODEBASE (this is the whole app)
    ├── index.html           entry point, all page markup, Ionic Web Components
    ├── css/style.css         design system / responsive layout
    ├── js/data.js            localStorage data layer (save + retrieve)
    └── js/app.js              navigation, rendering, event handling
```

Ionic (`@ionic/core`) and Ionicons are loaded straight from the jsDelivr CDN in
`index.html` — nothing is vendored into the repo. This keeps the source zip
small and free of the many small generated `.js` chunk files that some
antivirus tools flag as suspicious in a bundled copy of a JS framework.

Because `www/` is a plain static web app (no bundler/compiler required), the
**same, unmodified folder** is:
- served directly as the **website**, and
- wrapped by **Cordova** and compiled into the **Android APK**.

No code is duplicated or forked between platforms.

> **Internet connection required.** Ionic and Ionicons load from the jsDelivr
> CDN, so both the website and the installed Android app need a working
> internet connection the first time each page loads (the browser/WebView
> then caches those files). `config.xml` already allows this
> (`<access origin="*" />`, `<allow-navigation href="*" />`). If you need the
> Android app to work fully offline, see "Optional: bundle Ionic locally"
> below.

---

## 2. Run it as a website

Any static file server works. From the project root:

```bash
npx http-server www -p 8100
```

Then open `http://localhost:8100` in a browser. (Opening `www/index.html`
directly by double-clicking also works, since everything — including the
Ionic framework files in `www/lib/` — is bundled locally.)

Test responsiveness by resizing the browser window, or with DevTools' device
toolbar (Ctrl/Cmd+Shift+M) at a few widths (e.g. 1440px desktop, 820px tablet,
390px phone).

---

## 3. Build the Android APK

Requires: Node.js, the Android SDK / Android Studio, and a JDK (17+) installed
and on your `PATH`, as covered in the course setup.

```bash
# 1. install the Cordova CLI + Android platform tooling for this project
npm install

# 2. add the Android platform (only needed once)
npx cordova platform add android

# 3. build the APK from the SAME www/ folder used by the website
npx cordova build android
```

The debug APK is generated at:
```
platforms/android/app/build/outputs/apk/debug/app-debug.apk
```

Run it directly on a connected device/emulator with:
```bash
npx cordova run android
```

To test orientation handling, rotate the emulator (Ctrl+F11 / Ctrl+F12) or use
the on-device rotate button once the app is running, and confirm the layout
adapts in both portrait and landscape.

> `config.xml` sets `Orientation` to `default`, so the app is not locked to a
> single orientation — the CSS responsive rules in `css/style.css` handle the
> layout changes.

---

## 4. Data storage

All app data is saved locally on-device with the browser's/WebView's
`localStorage` API (see `js/data.js`), under these keys:

| Key | Contents |
|---|---|
| `studydeck_decks` | Every deck and its flashcards (question/answer pairs) |
| `studydeck_progress` | Cards studied, current streak, per-day study counts |
| `studydeck_settings` | Display name, theme, reminder/sound preferences |
| `studydeck_activity` | Recent-activity feed shown on the Home page |

Data is written with `localStorage.setItem()` and read back with
`localStorage.getItem()` (wrapped in `saveData()` / `loadData()` helpers), so
it persists between sessions on both the website and the installed Android app.

---

## 5. Optional: bundle Ionic locally (fully offline Android app)

If your Android device/emulator won't reliably have internet access, you can
vendor Ionic into the project instead of loading it from the CDN:

```bash
npm install @ionic/core@7.8.6 ionicons@7.2.2 --no-save --prefix /tmp/ionic-vendor

mkdir -p www/lib/ionic/css www/lib/ionicons
cp -r /tmp/ionic-vendor/node_modules/@ionic/core/dist/ionic          www/lib/ionic/ionic
cp    /tmp/ionic-vendor/node_modules/@ionic/core/css/ionic.bundle.css www/lib/ionic/css/
cp -r /tmp/ionic-vendor/node_modules/ionicons/dist/ionicons          www/lib/ionicons/ionicons
find www/lib -name "*.map" -delete
```

Then in `index.html`, swap the CDN `<link>`/`<script>` tags for local paths:

```html
<link rel="stylesheet" href="lib/ionic/css/ionic.bundle.css" />
<script type="module" src="lib/ionic/ionic/ionic.esm.js"></script>
<script nomodule src="lib/ionic/ionic/ionic.js"></script>
<script type="module" src="lib/ionicons/ionicons/ionicons.esm.js"></script>
<script nomodule src="lib/ionicons/ionicons/ionicons.js"></script>
```
