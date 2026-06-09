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
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
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
    private var locationManager: LocationManager? = null
    private var platformListener: LocationListener? = null

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
        // Boot/update resume (issue #89, proposal 2026-06-09): when started
        // from the BootReceiver there is no Activity and therefore no React
        // context or worklet -- location would stream into a dead bridge. Now
        // that we are a running foreground service (foreground procstate), it
        // is permitted to start the headless task that brings the worklet up,
        // even on Android 12+ where a background service start would be
        // refused. Idempotent: the JS start lock no-ops if the Activity
        // already started the backend, so the normal app-open path (no
        // EXTRA_FROM_BOOT) skips this and avoids spinning a redundant task.
        if (intent?.getBooleanExtra(EXTRA_FROM_BOOT, false) == true) {
            BackendHeadlessTaskService.ensureStarted(applicationContext)
        }
        // START_STICKY: if the OS kills us under memory pressure, retry
        // when resources free up.
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
        platformListener?.let { locationManager?.removeUpdates(it) }
        platformListener = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startLocationUpdates() {
        if (callback != null || platformListener != null) return
        // Fused requires Google Play Services. On de-Googled ROMs it never
        // delivers callbacks, so stream from the platform LocationManager
        // instead. Proposal 2026-06-03.
        if (PearCircleLocationModule.gmsAvailable(this)) {
            startFusedUpdates()
        } else {
            startPlatformUpdates()
        }
    }

    private fun startFusedUpdates() {
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

    // GMS-free streaming via the platform LocationManager. Same cadence
    // as the fused path (10s / 10m) so the worklet's lastSeen gating and
    // geofence math behave identically. GPS is primary; NETWORK is used
    // only when GPS is absent (on de-Googled devices NETWORK usually has
    // no backend). Proposal 2026-06-03.
    private fun startPlatformUpdates() {
        val lm = getSystemService(Context.LOCATION_SERVICE) as? LocationManager
        if (lm == null) { stopSelf(); return }
        locationManager = lm
        val provider = when {
            lm.allProviders.contains(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
            lm.allProviders.contains(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
            else -> { stopSelf(); return }
        }
        val listener = object : LocationListener {
            override fun onLocationChanged(loc: Location) {
                PearCircleLocationModule.instance?.emitToJs(loc)
            }
            // onProviderEnabled/Disabled/onStatusChanged gained default
            // implementations in API 30 but are abstract on API 29 (our
            // minSdk), so override them as no-ops to compile and run there.
            override fun onProviderEnabled(provider: String) {}
            override fun onProviderDisabled(provider: String) {}
            @Deprecated("Deprecated in API 29")
            override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
        }
        platformListener = listener
        try {
            lm.requestLocationUpdates(provider, 10_000L, 10f, listener, Looper.getMainLooper())
        } catch (e: SecurityException) {
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
        // Set by the BootReceiver so onStartCommand knows there is no Activity
        // behind this start and must bring the worklet up headlessly. Absent
        // (false) on the normal app-open path, where the Activity owns the
        // worklet. Proposal 2026-06-09.
        const val EXTRA_FROM_BOOT = "from_boot"

        fun start(ctx: Context) = start(ctx, false)

        fun start(ctx: Context, fromBoot: Boolean) {
            val intent = Intent(ctx, PearCircleLocationService::class.java)
            if (fromBoot) intent.putExtra(EXTRA_FROM_BOOT, true)
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
