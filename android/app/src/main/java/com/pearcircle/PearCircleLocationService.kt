package com.pearcircle

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

// Foreground service that keeps FusedLocationProvider running and the app
// process alive while the activity is backgrounded. Without this, the OS
// suspends our LocationCallback within seconds of leaving the app, which
// stops geofence transition firing on bare's location:update path.
//
// Updates are forwarded to JS via PearCircleLocationModule's static
// instance reference. When the React context is gone (rare; foreground
// service should keep the process alive) the emit is a silent no-op.
class PearCircleLocationService : Service() {

    private lateinit var client: FusedLocationProviderClient
    private var callback: LocationCallback? = null

    override fun onCreate() {
        super.onCreate()
        client = LocationServices.getFusedLocationProviderClient(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Android 14+ rejects startForeground(TYPE_LOCATION) with
        // SecurityException unless FINE or COARSE is already granted. On
        // fresh installs the JS-side permission flow can lose its
        // PermissionListener to expo-notifications' POST_NOTIFICATIONS
        // request, leading the location callback to receive the wrong
        // result and start this service before the location permission
        // was actually granted. Defensively skip the foreground promotion
        // in that case so the process doesn't die; the next explicit
        // startUpdates after a real grant will bring us up clean.
        if (!hasLocationPermission()) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        ensureChannel()
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        startLocationUpdates()
        // START_STICKY: if the OS kills us under memory pressure, retry
        // when resources free up. Cold-start-from-boot is a separate slice.
        return START_STICKY
    }

    private fun hasLocationPermission(): Boolean {
        val fine = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        return fine || coarse
    }

    override fun onDestroy() {
        callback?.let { client.removeLocationUpdates(it) }
        callback = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startLocationUpdates() {
        if (callback != null) return
        val req = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 10_000L)
            .setMinUpdateIntervalMillis(5_000L)
            // Movement gate (storage-growth remediation, proposal
            // 2026-05-29): without this the stream delivers every ~10s
            // regardless of movement, so a stationary phone wakes the
            // worklet and (pre-coalescing) appended a lastSeen block every
            // 10s. 10m stops the gateless stationary stream at the OS
            // level, cutting wakeups and battery; the worklet's own ~20m
            // gate stays authoritative for what actually gets written.
            .setMinUpdateDistanceMeters(10f)
            .build()
        val cb = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                // Route through the module's shared emitToJs so streaming
                // fixes and requestSingleFix one-shots carry identical
                // battery metadata. No-op if the React context is gone.
                result.lastLocation?.let { PearCircleLocationModule.instance?.emitToJs(it) }
            }
        }
        callback = cb
        try {
            client.requestLocationUpdates(req, cb, Looper.getMainLooper())
        } catch (e: SecurityException) {
            // ACCESS_FINE_LOCATION revoked while we were running.
            stopSelf()
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Location sharing",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Required to keep PearCircle sharing your location with your circles"
            setShowBadge(false)
        }
        mgr.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val openAppIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pi = openAppIntent?.let {
            PendingIntent.getActivity(
                this, 0, it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("PearCircle")
            .setContentText("Sharing your location with your circles")
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(pi)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "pearcircle_location"
        private const val NOTIFICATION_ID = 4710

        fun start(ctx: Context) {
            val intent = Intent(ctx, PearCircleLocationService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent)
            } else {
                ctx.startService(intent)
            }
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, PearCircleLocationService::class.java))
        }
    }
}
