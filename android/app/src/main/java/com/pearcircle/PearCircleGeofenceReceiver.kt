package com.pearcircle

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.util.Log
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingEvent

// Receives OS geofence crossings for Places (proposal 2026-09-30) and forwards
// them to the worklet's region:enter / region:exit handlers, the same path iOS
// CLCircularRegion events use. Two sources:
//   - fused GeofencingClient (Play services), one intent per batch
//   - LocationManager.addProximityAlert (no Play services), one intent per
//     Place, told apart by the region id in the intent data
// If the process was not running, the module is not up yet: the event is
// queued in the module's companion and the location service is started so the
// backend comes up headlessly, as after a reboot.
class PearCircleGeofenceReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val ts = System.currentTimeMillis()
        if (intent.hasExtra(LocationManager.KEY_PROXIMITY_ENTERING)) {
            val id = intent.data?.schemeSpecificPart ?: return
            val enter = intent.getBooleanExtra(LocationManager.KEY_PROXIMITY_ENTERING, false)
            dispatch(context, enter, id, ts)
            return
        }
        val event = GeofencingEvent.fromIntent(intent) ?: return
        if (event.hasError()) {
            Log.w(TAG, "geofence error ${event.errorCode}")
            return
        }
        val enter = when (event.geofenceTransition) {
            Geofence.GEOFENCE_TRANSITION_ENTER -> true
            Geofence.GEOFENCE_TRANSITION_EXIT -> false
            else -> return
        }
        for (g in event.triggeringGeofences ?: emptyList()) dispatch(context, enter, g.requestId, ts)
    }

    private fun dispatch(context: Context, enter: Boolean, id: String, ts: Long) {
        Log.w(TAG, "region ${if (enter) "enter" else "exit"} $id")
        val wasUp = PearCircleLocationModule.instance != null
        PearCircleLocationModule.dispatchRegionEvent(enter, id, ts)
        if (!wasUp && PearCircleLocationModule.isAutostartEnabled(context)) {
            try {
                PearCircleLocationService.start(context.applicationContext, true)
            } catch (e: Exception) {
                Log.w(TAG, "could not start location service from geofence: ${e.message}")
            }
        }
    }

    companion object {
        private const val TAG = "PearCircleGeofence"
        private const val ACTION = "com.pearcircle.GEOFENCE"

        // Both PendingIntents must be mutable: the system adds the
        // transition extras when it fires them.
        private val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)

        fun fusedPendingIntent(ctx: Context): PendingIntent {
            val intent = Intent(ctx, PearCircleGeofenceReceiver::class.java).setAction(ACTION)
            return PendingIntent.getBroadcast(ctx, 0, intent, flags)
        }

        // One PendingIntent per Place; the id in the data URI keeps them
        // distinct and tells onReceive which Place fired.
        fun proximityPendingIntent(ctx: Context, id: String): PendingIntent {
            val intent = Intent(ctx, PearCircleGeofenceReceiver::class.java)
                .setAction(ACTION)
                .setData(Uri.fromParts("pearcircle-region", id, null))
            return PendingIntent.getBroadcast(ctx, 0, intent, flags)
        }
    }
}
