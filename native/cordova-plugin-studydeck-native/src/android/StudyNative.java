package com.studydeck.nativeplugin;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;

import androidx.core.content.FileProvider;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.apache.cordova.PluginResult;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Cordova bridge. Provides:
 *  - permission state (granted / denied / blocked / prompt) incl. "permanently denied" detection
 *  - open app / location settings
 *  - start/stop of the foreground ShakeService and the persisted shake history
 *  - sharing an image through the Android share sheet (implicit ACTION_SEND intent)
 */
public class StudyNative extends CordovaPlugin {

    static final String PREFS = "studydeck_native";
    static final Object LOCK = new Object();
    static volatile boolean appInForeground = true;

    private static CallbackContext eventCallback;

    private final Map<Integer, CallbackContext> pendingCallbacks = new HashMap<Integer, CallbackContext>();
    private final Map<Integer, String> pendingKeys = new HashMap<Integer, String>();
    private int nextRequestCode = 4200;

    /* ---------------- lifecycle ---------------- */

    @Override
    public void onPause(boolean multitasking) { appInForeground = false; }

    @Override
    public void onResume(boolean multitasking) { appInForeground = true; }

    /* ---------------- events to JS ---------------- */

    static void emitShake(JSONObject entry) {
        try {
            JSONObject o = new JSONObject();
            o.put("type", "shake");
            o.put("entry", entry);
            emit(o);
        } catch (JSONException ignored) { }
    }

    static void emitService(boolean isRunning) {
        try {
            JSONObject o = new JSONObject();
            o.put("type", "service");
            o.put("running", isRunning);
            emit(o);
        } catch (JSONException ignored) { }
    }

    private static void emit(JSONObject o) {
        CallbackContext cb = eventCallback;
        if (cb == null) return;
        PluginResult r = new PluginResult(PluginResult.Status.OK, o);
        r.setKeepCallback(true);
        cb.sendPluginResult(r);
    }

    /* ---------------- dispatch ---------------- */

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext cb) throws JSONException {
        try {
            switch (action) {
                case "listen":
                    eventCallback = cb;
                    PluginResult keep = new PluginResult(PluginResult.Status.NO_RESULT);
                    keep.setKeepCallback(true);
                    cb.sendPluginResult(keep);
                    return true;
                case "checkPermission":
                    cb.success(permissionInfo(args.getString(0)));
                    return true;
                case "requestPermission":
                    requestPermission(args.getString(0), cb);
                    return true;
                case "openAppSettings":
                    openAppSettings();
                    cb.success();
                    return true;
                case "openLocationSettings":
                    startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS));
                    cb.success();
                    return true;
                case "isLocationEnabled":
                    cb.success(isLocationEnabled() ? 1 : 0);
                    return true;
                case "startService":
                    startService(cb);
                    return true;
                case "stopService":
                    ctx().stopService(new Intent(ctx(), ShakeService.class));
                    cb.success();
                    return true;
                case "isServiceRunning":
                    cb.success(ShakeService.running ? 1 : 0);
                    return true;
                case "setSensitivity": {
                    int level = Math.max(1, Math.min(10, args.getInt(0)));
                    prefs().edit().putInt("sensitivity", level).apply();
                    ShakeService.sensitivity = level;
                    cb.success(level);
                    return true;
                }
                case "getSensitivity":
                    cb.success(prefs().getInt("sensitivity", 5));
                    return true;
                case "getHistory":
                    synchronized (LOCK) {
                        cb.success(new JSONArray(prefs().getString("history", "[]")));
                    }
                    return true;
                case "clearHistory":
                    synchronized (LOCK) {
                        prefs().edit().putString("history", "[]").apply();
                    }
                    cb.success();
                    return true;
                case "shareImage":
                    shareImage(args.getString(0), args.optString(1, ""), cb);
                    return true;
                default:
                    return false;
            }
        } catch (Exception e) {
            cb.error(String.valueOf(e.getMessage()));
            return true;
        }
    }

    private Context ctx() { return cordova.getActivity().getApplicationContext(); }
    private Activity act() { return cordova.getActivity(); }
    private SharedPreferences prefs() { return ctx().getSharedPreferences(PREFS, Context.MODE_PRIVATE); }
    private void startActivity(Intent i) { act().startActivity(i); }

    /* ---------------- permissions ---------------- */

    private String[] permsFor(String key) {
        if ("camera".equals(key)) return new String[]{"android.permission.CAMERA"};
        if ("location".equals(key)) return new String[]{"android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"};
        if ("notifications".equals(key)) {
            return Build.VERSION.SDK_INT >= 33 ? new String[]{"android.permission.POST_NOTIFICATIONS"} : new String[0];
        }
        return new String[0];
    }

    private boolean isGranted(String perm) {
        return act().checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * granted  - usable now
     * prompt   - never requested, Android will show its dialog
     * denied   - user said no, but Android will still show the dialog again
     * blocked  - permanently denied ("don't ask again"); only system settings can fix it
     */
    private String stateOf(String key) {
        String[] perms = permsFor(key);
        if (perms.length == 0) return "granted";
        SharedPreferences sp = prefs();
        for (String p : perms) {
            if (isGranted(p)) {
                sp.edit().putBoolean("once_" + key, true).remove("state_" + key).apply();
                return "granted";
            }
        }
        String saved = sp.getString("state_" + key, null);
        if (saved != null) return saved;
        // Was granted before and has since been revoked in system settings.
        return sp.getBoolean("once_" + key, false) ? "denied" : "prompt";
    }

    private JSONObject permissionInfo(String key) throws JSONException {
        JSONObject o = new JSONObject();
        o.put("state", stateOf(key));
        if ("location".equals(key)) {
            o.put("precise", isGranted("android.permission.ACCESS_FINE_LOCATION"));
        }
        return o;
    }

    private void requestPermission(String key, CallbackContext cb) throws JSONException {
        String[] perms = permsFor(key);
        if (perms.length == 0 || "granted".equals(stateOf(key))) {
            cb.success(permissionInfo(key));
            return;
        }
        int code = nextRequestCode++;
        pendingCallbacks.put(code, cb);
        pendingKeys.put(code, key);
        cordova.requestPermissions(this, code, perms);
    }

    @Override
    public void onRequestPermissionResult(int requestCode, String[] permissions, int[] grantResults) throws JSONException {
        CallbackContext cb = pendingCallbacks.remove(requestCode);
        String key = pendingKeys.remove(requestCode);
        if (cb == null || key == null) return;

        boolean granted = false;
        for (int r : grantResults) if (r == PackageManager.PERMISSION_GRANTED) granted = true;
        if (!granted) {
            boolean canAskAgain = false;
            for (String p : permsFor(key)) {
                if (act().shouldShowRequestPermissionRationale(p)) canAskAgain = true;
            }
            prefs().edit().putString("state_" + key, canAskAgain ? "denied" : "blocked").apply();
        }
        cb.success(permissionInfo(key));
    }

    private void openAppSettings() {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        i.setData(Uri.fromParts("package", ctx().getPackageName(), null));
        startActivity(i);
    }

    private boolean isLocationEnabled() {
        LocationManager lm = (LocationManager) ctx().getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) return false;
        if (Build.VERSION.SDK_INT >= 28) return lm.isLocationEnabled();
        return lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
    }

    /* ---------------- service ---------------- */

    private void startService(CallbackContext cb) {
        if (!"granted".equals(stateOf("notifications"))) {
            cb.error("NOTIFICATION_PERMISSION");
            return;
        }
        try {
            Intent i = new Intent(ctx(), ShakeService.class).setAction(ShakeService.ACTION_START);
            if (Build.VERSION.SDK_INT >= 26) ctx().startForegroundService(i); else ctx().startService(i);
            cb.success();
        } catch (Exception e) {
            cb.error("SERVICE_START_FAILED: " + e.getMessage());
        }
    }

    /* ---------------- share intent ---------------- */

    private void shareImage(String base64, String text, CallbackContext cb) {
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (bmp == null) { cb.error("BAD_IMAGE"); return; }

            File dir = new File(ctx().getCacheDir(), "shared");
            if (!dir.exists()) dir.mkdirs();
            File[] old = dir.listFiles();
            if (old != null) for (File f : old) f.delete();      // keep only the photo being shared

            // Re-encoding the pixels drops all EXIF metadata (GPS position, device model...).
            File out = new File(dir, "studydeck_" + System.currentTimeMillis() + ".jpg");
            FileOutputStream fos = new FileOutputStream(out);
            bmp.compress(Bitmap.CompressFormat.JPEG, 90, fos);
            fos.close();

            Uri uri = FileProvider.getUriForFile(ctx(), ctx().getPackageName() + ".studydeck.fileprovider", out);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("image/jpeg");
            send.putExtra(Intent.EXTRA_STREAM, uri);
            if (text != null && text.length() > 0) send.putExtra(Intent.EXTRA_TEXT, text);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(Intent.createChooser(send, "Share photo"));
            cb.success();
        } catch (Exception e) {
            cb.error("SHARE_FAILED: " + e.getMessage());
        }
    }
}
