/*
 * Cordova after_prepare hook (Android only). Runs on every `cordova prepare/build`.
 *
 *  1. Bundles Ionic + Ionicons INTO the APK (copied from node_modules) and rewrites the
 *     copied index.html so the app never loads remote code. The website (GitHub Pages)
 *     keeps using the jsDelivr CDN because www/index.html itself is left untouched.
 *  2. Replaces the Content-Security-Policy in the APK copy with a strict, offline one.
 *  3. Removes manifest permissions the app does not need (least privilege).
 */
const fs = require('fs');
const path = require('path');

const REMOVE_PERMISSIONS = [
  'android.permission.INTERNET',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_AUDIO'
];

const STRICT_CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  "object-src 'none'; base-uri 'self'; form-action 'none'";

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

module.exports = function (context) {
  const platforms = (context.opts && context.opts.platforms) || [];
  if (platforms.length && platforms.indexOf('android') === -1) return;

  const root = context.opts.projectRoot;
  const androidMain = path.join(root, 'platforms', 'android', 'app', 'src', 'main');
  const wwwOut = path.join(androidMain, 'assets', 'www');
  const indexPath = path.join(wwwOut, 'index.html');

  /* ---- 1 + 2: offline Ionic and strict CSP ---- */
  const ionicDist = path.join(root, 'node_modules', '@ionic', 'core', 'dist', 'ionic');
  const ionicCss = path.join(root, 'node_modules', '@ionic', 'core', 'css', 'ionic.bundle.css');
  const iconsDist = path.join(root, 'node_modules', 'ionicons', 'dist', 'ionicons');

  if (fs.existsSync(indexPath)) {
    if (!fs.existsSync(ionicDist) || !fs.existsSync(ionicCss) || !fs.existsSync(iconsDist)) {
      throw new Error('after-prepare: run "npm install" first - @ionic/core and ionicons are needed to bundle Ionic into the APK.');
    }
    copyDir(ionicDist, path.join(wwwOut, 'lib', 'ionic'));
    copyDir(iconsDist, path.join(wwwOut, 'lib', 'ionicons'));
    fs.copyFileSync(ionicCss, path.join(wwwOut, 'lib', 'ionic.bundle.css'));

    let html = fs.readFileSync(indexPath, 'utf8');
    html = html
      .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/@ionic\/core@[\d.]+\/css\//g, 'lib/')
      .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/@ionic\/core@[\d.]+\/dist\/ionic\//g, 'lib/ionic/')
      .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/ionicons@[\d.]+\/dist\/ionicons\//g, 'lib/ionicons/')
      .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i,
        '<meta http-equiv="Content-Security-Policy" content="' + STRICT_CSP + '" />');
    if (/https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, '').replace(/xmlns="[^"]*"/g, ''))) {
      console.warn('after-prepare: WARNING - index.html in the APK still references a remote URL.');
    }
    fs.writeFileSync(indexPath, html);
    console.log('after-prepare: Ionic bundled offline and strict CSP applied.');
  }

  /* ---- 3: least-privilege manifest ---- */
  const manifestPath = path.join(androidMain, 'AndroidManifest.xml');
  if (fs.existsSync(manifestPath)) {
    let xml = fs.readFileSync(manifestPath, 'utf8');
    for (const perm of REMOVE_PERMISSIONS) {
      const re = new RegExp('[ \\t]*<uses-permission[^>]*android:name="' + perm.replace(/\./g, '\\.') + '"[^>]*/>[ \\t]*\\r?\\n?', 'g');
      xml = xml.replace(re, '');
    }
    fs.writeFileSync(manifestPath, xml);
    const left = (xml.match(/<uses-permission[^>]*>/g) || []).join('\n  ');
    console.log('after-prepare: manifest permissions now:\n  ' + left);
  }
};
