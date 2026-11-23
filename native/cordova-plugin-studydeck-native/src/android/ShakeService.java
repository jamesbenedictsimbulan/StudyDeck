package com.studydeck.nativeplugin;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Build;
import android.os.IBinder;
import android.os.VibrationEffect;
import android.os.Vibrator;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Real Android foreground service. It listens to the accelerometer through SensorManager,
 * detects a shake from the raw magnitude, and records a study marker. Because it is a
 * foreground service (with a persistent notification) it keeps receiving sensor events
 * while the WebView / app is in the background.
 */
public class ShakeService extends Service implements SensorEventListener {

    static final String ACTION_START = "com.studydeck.START";
    static final String ACTION_STOP = "com.studydeck.STOP";

    private static final String CHANNEL_SERVICE = "studydeck_service";
    private static final String CHANNEL_ALERT = "studydeck_shake";
    private static final int ID_SERVICE = 1001;
    private static final int ID_ALERT = 1002;
    private static final long COOLDOWN_MS = 2000;   // one shake => one action
    private static final int MAX_HISTORY = 100;

    static volatile boolean running = false;
    static volatile int sensitivity = 5;             // 1 (hard shake) .. 10 (light shake)

    private SensorManager sensorManager;
    private long lastShakeAt = 0;
    private float peak = 0f;

    /** Magnitude (in g, gravity included) that counts as a shake for a given sensitivity. */
    static float thresholdG(int level) {
        int l = Math.max(1, Math.min(10, level));
        return 3.3f - 0.18f * l;                     // level 1 => 3.12 g, level 10 => 1.5 g
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        sensorManager = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }

        Notification n = buildOngoingNotification();
        if (Build.VERSION.SDK_INT >= 34) {
            // FOREGROUND_SERVICE_TYPE_SPECIAL_USE == 0x40000000
            startForeground(ID_SERVICE, n, 0x40000000);
        } else {
            startForeground(ID_SERVICE, n);
        }

        if (!running) {
            Sensor accel = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
            if (accel == null) {
                stopSelf();
                return START_NOT_STICKY;
            }
            SharedPreferences sp = getSharedPreferences(StudyNative.PREFS, MODE_PRIVATE);
            sensitivity = sp.getInt("sensitivity", 5);
            sensorManager.registerListener(this, accel, SensorManager.SENSOR_DELAY_GAME);
            running = true;
            StudyNative.emitService(true);
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (sensorManager != null) sensorManager.unregisterListener(this);
        running = false;
        stopForeground(Service.STOP_FOREGROUND_REMOVE);
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(ID_SERVICE);
        StudyNative.emitService(false);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) { }

    @Override
    public void onSensorChanged(SensorEvent event) {
        float x = event.values[0], y = event.values[1], z = event.values[2];
        float g = (float) Math.sqrt(x * x + y * y + z * z) / SensorManager.GRAVITY_EARTH;
        long now = System.currentTimeMillis();
        if (g > peak) peak = g;
        if (g >= thresholdG(sensitivity) && now - lastShakeAt > COOLDOWN_MS) {
            lastShakeAt = now;
            float p = peak;
            peak = 0f;
            onShake(now, p);
        } else if (now - lastShakeAt > COOLDOWN_MS && g < 1.2f) {
            peak = 0f;
        }
    }

    private void onShake(long now, float g) {
        vibrate();
        JSONObject entry = new JSONObject();
        try {
            entry.put("id", now);
            entry.put("ts", now);
            entry.put("g", Math.round(g * 100f) / 100f);
            entry.put("background", !StudyNative.appInForeground);
        } catch (Exception ignored) { }
        saveEntry(entry);
        postAlert(now);
        StudyNative.emitShake(entry);
    }

    @SuppressWarnings("deprecation")
    private void vibrate() {
        try {
            Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (v == null) return;
            if (Build.VERSION.SDK_INT >= 26) {
                v.vibrate(VibrationEffect.createOneShot(300, VibrationEffect.DEFAULT_AMPLITUDE));
            } else {
                v.vibrate(300);
            }
        } catch (Exception ignored) { }
    }

    private void saveEntry(JSONObject entry) {
        synchronized (StudyNative.LOCK) {
            SharedPreferences sp = getSharedPreferences(StudyNative.PREFS, MODE_PRIVATE);
            JSONArray out = new JSONArray();
            out.put(entry);
            try {
                JSONArray old = new JSONArray(sp.getString("history", "[]"));
                for (int i = 0; i < old.length() && out.length() < MAX_HISTORY; i++) out.put(old.get(i));
            } catch (Exception ignored) { }
            sp.edit().putString("history", out.toString()).apply();
        }
    }

    private void postAlert(long now) {
        // On Android 13+ the notification permission may have been revoked; never crash because of it.
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            return;
        }
        try {
            String time = new SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(new Date(now));
            Notification.Builder b = newBuilder(CHANNEL_ALERT)
                    .setSmallIcon(android.R.drawable.ic_dialog_info)
                    .setContentTitle("Study marker saved")
                    .setContentText("Shake detected at " + time)
                    .setAutoCancel(true)
                    .setContentIntent(openAppIntent());
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(ID_ALERT, b.build());
        } catch (Exception ignored) { }
    }

    private Notification buildOngoingNotification() {
        Intent stop = new Intent(this, ShakeService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stop,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = newBuilder(CHANNEL_SERVICE)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("StudyDeck Focus Mode is on")
                .setContentText("Listening for a shake to save a study marker.")
                .setOngoing(true)
                .setContentIntent(openAppIntent())
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopPi);
        b.setVisibility(Notification.VISIBILITY_PRIVATE);
        return b.build();
    }

    private Notification.Builder newBuilder(String channel) {
        return Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, channel) : new Notification.Builder(this);
    }

    private PendingIntent openAppIntent() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch == null) launch = new Intent();
        return PendingIntent.getActivity(this, 0, launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_SERVICE, "Focus Mode service", NotificationManager.IMPORTANCE_LOW));
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_ALERT, "Study markers", NotificationManager.IMPORTANCE_DEFAULT));
    }
}
