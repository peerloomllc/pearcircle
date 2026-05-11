package com.pearcircle

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener

class PearCircleLocationModule(private val ctx: ReactApplicationContext)
    : ReactContextBaseJavaModule(ctx) {

    init {
        instance = this
        registerNetworkCallback()
    }

    override fun getName() = "PearCircleLocation"

    @ReactMethod
    fun startUpdates(promise: Promise) {
        if (!hasFineLocation()) {
            requestFineLocation { granted ->
                if (!granted) { promise.resolve(false); return@requestFineLocation }
                ensureNotificationsAndStart(promise)
            }
            return
        }
        ensureNotificationsAndStart(promise)
    }

    @ReactMethod
    fun stopUpdates(promise: Promise) {
        PearCircleLocationService.stop(ctx)
        promise.resolve(true)
    }

    // Battery optimization is the OEM/Doze gate that pauses the
    // foreground location service after extended idle. Asking the
    // user to exempt the app keeps sharing reliable but is opt-in
    // because exemption is a real privacy/battery posture change.
    @ReactMethod
    fun isIgnoringBatteryOptimizations(promise: Promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            // Pre-Doze; the concept doesn't apply.
            promise.resolve(true)
            return
        }
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        promise.resolve(pm.isIgnoringBatteryOptimizations(ctx.packageName))
    }

    @ReactMethod
    fun requestIgnoreBatteryOptimizations(promise: Promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            promise.resolve(true)
            return
        }
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:" + ctx.packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            ctx.startActivity(intent)
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.reject("ACTIVITY_NOT_FOUND", e.message ?: "Unable to open battery optimization dialog")
        }
    }

    // Required by RN even when we deliver via DeviceEventManagerModule.
    @ReactMethod fun addListener(eventName: String) { /* no-op */ }
    @ReactMethod fun removeListeners(count: Int) { /* no-op */ }

    // Cross-platform parity with the iOS PearCircleLocationModule.swift
    // getAuthorizationStatus. Returns one of:
    //   'always'         FINE + BACKGROUND_LOCATION both granted (or
    //                    background isn't required on pre-Q devices)
    //   'whenInUse'      FINE granted but BACKGROUND_LOCATION not.
    //                    Android calls this "Allow only while using the
    //                    app" in Settings.
    //   'denied'         FINE not granted (Android can't cleanly
    //                    distinguish notDetermined from denied without
    //                    activity-scoped permission rationale, so we
    //                    fold both into 'denied' from the UI's point
    //                    of view — the banner copy works either way).
    // Pure read; never triggers a dialog. Used by the shell to drive
    // the home banner that nudges users to Settings → "Allow all the
    // time".
    @ReactMethod
    fun getAuthorizationStatus(promise: Promise) {
        val fine = hasFineLocation()
        if (!fine) { promise.resolve("denied"); return }
        val bgRequired = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
        val bgGranted = !bgRequired ||
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
                PackageManager.PERMISSION_GRANTED
        promise.resolve(if (bgGranted) "always" else "whenInUse")
    }

    fun emitLocation(lat: Double, lon: Double, accuracy: Double, ts: Double, speed: Double, battery: Double?, isCharging: Boolean) {
        val payload: WritableMap = Arguments.createMap().apply {
            putDouble("lat", lat)
            putDouble("lon", lon)
            putDouble("accuracy", accuracy)
            putDouble("ts", ts)
            putDouble("speed", speed)
            if (battery != null) putDouble("battery", battery) else putNull("battery")
            putBoolean("isCharging", isCharging)
        }
        try {
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("PearCircleLocation:update", payload)
        } catch (_: Throwable) {
            // React context torn down; service will retry on next callback.
        }
    }

    private fun ensureNotificationsAndStart(promise: Promise) {
        // Android 13+ requires POST_NOTIFICATIONS at runtime for the
        // foreground-service notification to be visible. Service still
        // runs without it, but the user can't see / dismiss the
        // notification, which surprises people. Request once; treat
        // denial as non-fatal.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !hasNotifications()) {
            requestNotifications {
                PearCircleLocationService.start(ctx)
                promise.resolve(true)
            }
            return
        }
        PearCircleLocationService.start(ctx)
        promise.resolve(true)
    }

    private fun hasFineLocation(): Boolean =
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    private fun hasNotifications(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED

    private fun requestFineLocation(cb: (Boolean) -> Unit) {
        val activity = getCurrentActivity() as? PermissionAwareActivity
        if (activity == null) { cb(false); return }
        val listener = PermissionListener { _, _, results ->
            cb(results.isNotEmpty() && results[0] == PackageManager.PERMISSION_GRANTED)
            true
        }
        activity.requestPermissions(
            arrayOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION,
            ),
            REQ_FINE,
            listener,
        )
    }

    private fun requestNotifications(cb: () -> Unit) {
        val activity = getCurrentActivity() as? PermissionAwareActivity
        if (activity == null) { cb(); return }
        val listener = PermissionListener { _, _, _ -> cb(); true }
        activity.requestPermissions(
            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
            REQ_NOTIFICATIONS,
            listener,
        )
    }

    // Default-network change handling. Hyperswarm's DHT announcement is
    // tied to the local IP at the time of the announce; when the device
    // moves between wifi and cell, peers can't find us until Hyperswarm's
    // internal periodic re-announce eventually fires (minute-ish in the
    // 2026-05-07 cold-start investigation). Detect default-network
    // changes here, debounce 2s to coalesce the burst Android emits
    // during a single transition, and emit one event per real network
    // identity change. The worklet's `network:changed` handler responds
    // by calling `_swarm.flush()` so the announce happens promptly on
    // the new network.
    // Initialized lazily inside registerNetworkCallback() rather than as
    // a `by lazy` delegate, because `init {}` runs before the delegate
    // field is wired up — the resulting NPE wasted a smoke-test iteration
    // before the diagnostic Log.w surfaced it.
    private var connectivity: ConnectivityManager? = null
    private val debounceHandler = Handler(Looper.getMainLooper())
    private var pendingEmit: Runnable? = null
    private var lastNetHandle: Long? = null
    private var hasSeenInitialNetwork = false
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    private fun registerNetworkCallback() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            Log.w(TAG, "registerNetworkCallback: skipped, API < N")
            return
        }
        if (networkCallback != null) {
            Log.w(TAG, "registerNetworkCallback: already registered")
            return
        }
        val cm = try {
            ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        } catch (e: Throwable) {
            Log.w(TAG, "registerNetworkCallback: getSystemService threw: ${e.message}")
            null
        }
        if (cm == null) {
            Log.w(TAG, "registerNetworkCallback: ConnectivityManager unavailable")
            return
        }
        connectivity = cm
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val handle = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) network.networkHandle else 0L
                Log.w(TAG, "onAvailable handle=$handle prev=$lastNetHandle hasSeenInitial=$hasSeenInitialNetwork")
                if (lastNetHandle == handle) return
                lastNetHandle = handle
                // Skip the first onAvailable across the lifetime of this
                // module instance: it's the network the worklet is already
                // running on at app start. Re-announcing on the initial
                // network is wasted work. After wifi off -> on cycles,
                // hasSeenInitialNetwork stays true so the new onAvailable
                // correctly emits a change.
                if (!hasSeenInitialNetwork) {
                    hasSeenInitialNetwork = true
                    Log.w(TAG, "onAvailable: marking initial, skipping emit")
                    return
                }
                Log.w(TAG, "onAvailable: scheduling debounced emit")
                scheduleDebouncedEmit(network)
            }
            override fun onLost(network: Network) {
                Log.w(TAG, "onLost handle=${if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) network.networkHandle else 0L}")
                pendingEmit?.let { debounceHandler.removeCallbacks(it) }
                pendingEmit = null
                lastNetHandle = null
            }
        }
        try {
            cm.registerDefaultNetworkCallback(cb)
            networkCallback = cb
            Log.w(TAG, "registerNetworkCallback: registered")
        } catch (e: Throwable) {
            Log.w(TAG, "registerNetworkCallback: failed: ${e.message}")
        }
    }

    private fun scheduleDebouncedEmit(network: Network) {
        pendingEmit?.let { debounceHandler.removeCallbacks(it) }
        val r = Runnable {
            pendingEmit = null
            emitNetworkChanged(network)
        }
        pendingEmit = r
        debounceHandler.postDelayed(r, DEBOUNCE_MS)
    }

    private fun emitNetworkChanged(network: Network) {
        val cm = connectivity
        val caps = if (cm != null) {
            try { cm.getNetworkCapabilities(network) } catch (_: Throwable) { null }
        } else null
        val transport = when {
            caps == null -> "unknown"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
            else -> "unknown"
        }
        val handle = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) network.networkHandle else 0L
        Log.w(TAG, "emitNetworkChanged transport=$transport handle=$handle")
        val payload: WritableMap = Arguments.createMap().apply {
            putString("transport", transport)
            putDouble("netHandle", handle.toDouble())
        }
        try {
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("PearCircleLocation:network:changed", payload)
            Log.w(TAG, "emitNetworkChanged: emitted to JS")
        } catch (e: Throwable) {
            Log.w(TAG, "emitNetworkChanged: emit failed: ${e.message}")
        }
    }

    companion object {
        private const val TAG = "PearCircleLocation"
        private const val REQ_FINE = 4711
        private const val REQ_NOTIFICATIONS = 4713
        private const val DEBOUNCE_MS = 2000L
        @JvmStatic var instance: PearCircleLocationModule? = null
    }
}
