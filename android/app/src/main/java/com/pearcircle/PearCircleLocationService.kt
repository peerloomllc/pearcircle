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
import android.hardware.Sensor
import android.hardware.SensorManager
import android.hardware.TriggerEvent
import android.hardware.TriggerEventListener
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
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
    // Mode the current request was built for, so applyMode can skip a no-op.
    private var activeMode: String? = null

    // Significant-motion wake (proposal 2026-09-30). A one-shot sensor on the
    // low-power sensor hub: no permission, no Play services. Each trigger tells
    // the worklet the phone is moving, which escalates the adaptive mode to
    // tracking; MOTION_QUIET_MS without a trigger reports it still again.
    private val handler = Handler(Looper.getMainLooper())
    private var sensorManager: SensorManager? = null
    private var sigMotion: Sensor? = null
    private var moving = false
    private var lastMotionAt = 0L
    private val motionListener = object : TriggerEventListener() {
        override fun onTrigger(event: TriggerEvent?) {
            lastMotionAt = SystemClock.elapsedRealtime()
            if (!moving) {
                moving = true
                PearCircleLocationModule.instance?.emitMotion(true)
            }
            handler.removeCallbacks(quietCheck)
            handler.postDelayed(quietCheck, MOTION_QUIET_MS)
            armMotion()
        }
    }
    private val quietCheck = Runnable { checkMotionQuiet() }

    override fun onCreate() {
        super.onCreate()
        client = LocationServices.getFusedLocationProviderClient(this)
        running = this
        sensorManager = getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        sigMotion = sensorManager?.getDefaultSensor(Sensor.TYPE_SIGNIFICANT_MOTION)
        if (sigMotion == null) Log.w(TAG, "no significant-motion sensor; mode follows trip phase and foreground only")
        armMotion()
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
        // A null intent is a START_STICKY restart after the OS killed the
        // process: the worklet died with it, so bring it back the same way.
        if (intent == null || intent.getBooleanExtra(EXTRA_FROM_BOOT, false)) {
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
        removeLocationUpdates()
        handler.removeCallbacks(quietCheck)
        sigMotion?.let { sensorManager?.cancelTriggerSensor(motionListener, it) }
        if (running === this) running = null
        super.onDestroy()
    }

    private fun armMotion() {
        val sensor = sigMotion ?: return
        sensorManager?.requestTriggerSensor(motionListener, sensor)
    }

    // Also called on every fix: Handler delays do not advance while the CPU is
    // in deep sleep, so the timer alone could hold "moving" far too long.
    private fun checkMotionQuiet() {
        if (!moving) return
        val quietFor = SystemClock.elapsedRealtime() - lastMotionAt
        if (quietFor >= MOTION_QUIET_MS) {
            moving = false
            handler.removeCallbacks(quietCheck)
            PearCircleLocationModule.instance?.emitMotion(false)
        } else {
            handler.removeCallbacks(quietCheck)
            handler.postDelayed(quietCheck, MOTION_QUIET_MS - quietFor)
        }
    }

    private fun onFix(loc: Location) {
        checkMotionQuiet()
        PearCircleLocationModule.instance?.emitToJs(loc)
    }

    private fun removeLocationUpdates() {
        callback?.let { client.removeLocationUpdates(it) }
        callback = null
        platformListener?.let { locationManager?.removeUpdates(it) }
        platformListener = null
        activeMode = null
    }

    // Re-request updates for the current effective mode. Runs on the main
    // thread (setMode and the geofence health change post here).
    private fun applyMode() {
        if (activeMode == effectiveMode()) return
        removeLocationUpdates()
        startLocationUpdates()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startLocationUpdates() {
        if (callback != null || platformListener != null) return
        val mode = effectiveMode()
        activeMode = mode
        Log.w(TAG, "location request mode=$mode")
        // Fused requires Google Play Services. On de-Googled ROMs it never
        // delivers callbacks, so stream from the platform LocationManager
        // instead. Proposal 2026-06-03.
        if (PearCircleLocationModule.gmsAvailable(this)) {
            startFusedUpdates(mode)
        } else {
            startPlatformUpdates(mode)
        }
    }

    private fun startFusedUpdates(mode: String) {
        // Idle: wifi and cell only, no GPS (proposal 2026-09-30). Arrive/leave
        // alerts come from OS geofences meanwhile, and motion or the app
        // opening switches back to tracking.
        val req = if (mode == MODE_IDLE) {
            LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, IDLE_INTERVAL_MS)
                .setMinUpdateIntervalMillis(IDLE_MIN_INTERVAL_MS)
                .setMinUpdateDistanceMeters(IDLE_MIN_DISTANCE_M)
                .build()
        } else LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 10_000L)
            .setMinUpdateIntervalMillis(5_000L)
            .setMinUpdateDistanceMeters(trackingMinDistance(mode))
            .build()
        val cb = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                // Route through the module's shared emitToJs so streaming
                // fixes and requestSingleFix one-shots carry identical
                // battery metadata. No-op if the React context is gone.
                result.lastLocation?.let { onFix(it) }
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
    //
    // Idle uses NETWORK when the device has one, else PASSIVE: fixes other
    // apps request, with the GPS never powered on our behalf.
    private fun startPlatformUpdates(mode: String) {
        val lm = getSystemService(Context.LOCATION_SERVICE) as? LocationManager
        if (lm == null) { stopSelf(); return }
        locationManager = lm
        val providers = lm.allProviders
        val provider = when {
            mode == MODE_IDLE && providers.contains(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
            mode == MODE_IDLE && providers.contains(LocationManager.PASSIVE_PROVIDER) -> LocationManager.PASSIVE_PROVIDER
            providers.contains(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
            providers.contains(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
            else -> { stopSelf(); return }
        }
        val minTime = if (mode == MODE_IDLE) IDLE_INTERVAL_MS else 10_000L
        val minDistance = if (mode == MODE_IDLE) IDLE_MIN_DISTANCE_M else trackingMinDistance(mode)
        val listener = object : LocationListener {
            override fun onLocationChanged(loc: Location) {
                onFix(loc)
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
            lm.requestLocationUpdates(provider, minTime, minDistance, listener, Looper.getMainLooper())
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
        private const val TAG = "PearCircleLocation"
        private const val CHANNEL_ID = "pearcircle_location"
        const val MODE_IDLE = "idle"
        const val MODE_TRACKING = "tracking"
        private const val IDLE_INTERVAL_MS = 5 * 60_000L
        private const val IDLE_MIN_INTERVAL_MS = 60_000L
        private const val IDLE_MIN_DISTANCE_M = 50f
        private const val MOTION_QUIET_MS = 3 * 60_000L

        @Volatile private var running: PearCircleLocationService? = null

        // Requested by the worklet's adaptive mode driver via setMode. Kept
        // here, not on the instance, so a service restart within the same
        // process resumes the last requested mode. Tracking is the safe
        // default until the worklet says otherwise.
        @Volatile var requestedMode: String = MODE_TRACKING
            private set

        // False while Places exist but their OS geofences failed to register
        // (for example location granted only while in use). Idle would then
        // miss arrive/leave alerts, so the service stays in tracking.
        @Volatile var geofencesHealthy: Boolean = true
            private set

        // Mode the request is built for. FALLBACK is the pre-2026-09-30
        // request: idle was asked for but geofences are not registered, so
        // keep GPS on with the 10m filter rather than miss alerts.
        private const val MODE_FALLBACK = "fallback"

        private fun effectiveMode(): String = when {
            requestedMode != MODE_IDLE -> MODE_TRACKING
            geofencesHealthy -> MODE_IDLE
            else -> MODE_FALLBACK
        }

        // Tracking has no distance filter. GPS is on anyway, and a fix every
        // 10s is what lets the worklet notice, by wall-clock time, that a trip
        // ended or motion stopped and step back to idle. Its own timers do not
        // advance while the CPU is suspended, and the 10m filter starved a
        // parked phone of fixes. The worklet's 20m gate still decides what is
        // written. Fallback keeps the 10m filter from the 2026-05-29 storage
        // proposal, which cut wakeups for a phone streaming all day.
        private fun trackingMinDistance(mode: String): Float = if (mode == MODE_FALLBACK) 10f else 0f

        fun setMode(mode: String) {
            requestedMode = if (mode == MODE_IDLE) MODE_IDLE else MODE_TRACKING
            reapply()
        }

        fun setGeofencesHealthy(healthy: Boolean) {
            if (geofencesHealthy == healthy) return
            geofencesHealthy = healthy
            reapply()
        }

        private fun reapply() {
            Handler(Looper.getMainLooper()).post { running?.applyMode() }
        }
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
