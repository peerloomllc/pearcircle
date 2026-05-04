package com.pearcircle

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.location.Location
import android.os.Looper
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

class PearCircleLocationModule(private val ctx: ReactApplicationContext)
    : ReactContextBaseJavaModule(ctx) {

    private val client: FusedLocationProviderClient =
        LocationServices.getFusedLocationProviderClient(ctx)

    private var callback: LocationCallback? = null

    override fun getName() = "PearCircleLocation"

    @ReactMethod
    fun startUpdates(promise: Promise) {
        if (!hasFineLocation()) {
            requestPermission(promise)
            return
        }
        beginUpdates(promise)
    }

    @ReactMethod
    fun stopUpdates(promise: Promise) {
        callback?.let { client.removeLocationUpdates(it) }
        callback = null
        promise.resolve(true)
    }

    // Required by RN even when we deliver via DeviceEventManagerModule.
    @ReactMethod fun addListener(eventName: String) { /* no-op */ }
    @ReactMethod fun removeListeners(count: Int) { /* no-op */ }

    @ReactMethod
    fun registerGeofence(args: com.facebook.react.bridge.ReadableMap, promise: Promise) {
        // Stub: geofencing lands in a later slice.
        promise.resolve(false)
    }

    private fun hasFineLocation(): Boolean =
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    private fun requestPermission(promise: Promise) {
        val activity = getCurrentActivity() as? PermissionAwareActivity
        if (activity == null) {
            promise.reject("no_activity", "current activity is not permission-aware")
            return
        }
        val listener = PermissionListener { _, _, results ->
            val granted = results.isNotEmpty() && results[0] == PackageManager.PERMISSION_GRANTED
            if (granted) beginUpdates(promise) else promise.resolve(false)
            true
        }
        activity.requestPermissions(
            arrayOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION,
            ),
            REQ_LOCATION,
            listener,
        )
    }

    private fun beginUpdates(promise: Promise) {
        if (callback != null) { promise.resolve(true); return }

        val req = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 10_000L)
            .setMinUpdateIntervalMillis(5_000L)
            .build()

        val cb = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                result.lastLocation?.let { emit(it) }
            }
        }
        callback = cb

        try {
            client.requestLocationUpdates(req, cb, Looper.getMainLooper())
            promise.resolve(true)
        } catch (e: SecurityException) {
            callback = null
            promise.reject("permission_denied", e.message, e)
        }
    }

    private fun emit(loc: Location) {
        val payload: WritableMap = Arguments.createMap().apply {
            putDouble("lat", loc.latitude)
            putDouble("lon", loc.longitude)
            putDouble("accuracy", loc.accuracy.toDouble())
            putDouble("ts", loc.time.toDouble())
            putDouble("speed", loc.speed.toDouble())
        }
        ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("PearCircleLocation:update", payload)
    }

    companion object {
        private const val REQ_LOCATION = 4711
    }
}
