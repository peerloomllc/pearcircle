package com.pearcircle

import android.content.Context
import android.content.Intent
import android.util.Log
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

// Hosts the "PearCircleBackend" headless JS task (registered in index.js).
// The task calls ensureBackendStarted(), which brings the Bare worklet and
// the native location IPC plumbing up WITHOUT mounting the WebView UI, so a
// reboot/update resume actually replicates instead of collecting fixes into
// a dead bridge (issue #89). Proposal 2026-06-09.
//
// Single process by design (no android:process in the manifest): the headless
// task and, later, the Activity share one ReactHost / JS runtime, so the
// worklet's _workletStarted singleton + the JS start lock guarantee exactly
// one Autobase writer whichever path starts it first. The single-open hazard
// (two writers corrupting the local view) is the whole reason this stays
// in-process.
//
// Lifecycle: this service only kicks the JS task; it does not itself hold the
// process open. The PearCircleLocationService foreground service is the
// process anchor that keeps the worklet alive after the task's promise
// resolves. ensureStarted is called from that FGS once it is in the
// foreground procstate, so this plain (non-foreground) service start is
// permitted even on Android 12+ where a true background start would be
// refused.
class BackendHeadlessTaskService : HeadlessJsTaskService() {

    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig {
        return HeadlessJsTaskConfig(
            TASK_KEY,
            Arguments.createMap(),
            // No timeout: ensureBackendStarted resolves quickly via the start
            // lock and the FGS keeps the worklet alive afterwards, so there is
            // nothing to time out.
            0L,
            // allowedInForeground = true: the location FGS puts us in a
            // foreground procstate, and RN otherwise refuses to run a headless
            // task while the app is considered foreground. We want it to run
            // either way -- it is idempotent if a context already exists.
            true,
        )
    }

    companion object {
        private const val TASK_KEY = "PearCircleBackend"
        private const val TAG = "PearCircleBackend"

        // Start the headless task to bring the worklet up. Idempotent at the
        // JS layer (the start lock no-ops if the Activity already started the
        // backend). Wrapped so a refusal logs instead of crashing the FGS.
        fun ensureStarted(ctx: Context) {
            try {
                ctx.startService(Intent(ctx, BackendHeadlessTaskService::class.java))
            } catch (e: Exception) {
                Log.w(TAG, "headless backend start refused: ${e.message}")
            }
        }
    }
}
