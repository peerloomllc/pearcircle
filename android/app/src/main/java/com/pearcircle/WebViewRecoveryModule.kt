package com.pearcircle

import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

// GrapheneOS/Vanadium WebView resume-freeze recovery (2026-07-21).
//
// Root cause (proven from live logcat on the Pixel): Android's cached-app
// freezer cgroup-freezes the WebView's out-of-process Vanadium renderer while
// the app is backgrounded. After the 2026-07-19 Vanadium 151 update, on resume
// the app gets a NEW window surface but the thawed renderer's compositor never
// re-attaches to it, so it produces zero new buffers -- a frozen screen even
// though React/JS/input all still run (they live in the app process, which is
// fine). It is NOT memory (reproduced with 5.4 GB free), not app weight, not a
// bundled package, not edge-to-edge.
//
// The only thing that recovers it is a FRESH render process (dismiss+reopen, or
// this). A WebView view-remount does NOT work -- it rebinds the same pooled,
// stale renderer. `WebViewRenderProcess.terminate()` (API 29+, we are minSdk 29)
// terminates just THIS app's renderer; react-native-webview's onRenderProcessGone
// handler then reloads a fresh renderer that binds the current surface and paints.
class WebViewRecoveryModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = "WebViewRecovery"

    // Terminate the render process of the app's WebView. Runs on the UI thread
    // (WebView APIs are main-thread only). Resolves the number of WebViews whose
    // renderer was terminated (0 if none found / API too old).
    @ReactMethod
    fun terminateRenderer(promise: Promise) {
        val activity = reactApplicationContext.currentActivity
        if (activity == null) {
            promise.resolve(0)
            return
        }
        activity.runOnUiThread {
            try {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                    // getWebViewRenderProcess()/terminate() are API 29+. Below
                    // that the renderer is in-process and this freeze does not
                    // apply, so nothing to do.
                    promise.resolve(0)
                    return@runOnUiThread
                }
                val root = activity.window?.decorView
                var terminated = 0
                for (wv in findWebViews(root)) {
                    // terminate() fires onRenderProcessGone(didCrash=false); the
                    // JS onRenderProcessGone handler reloads the WebView, which
                    // spawns a fresh renderer bound to the current surface.
                    if (wv.webViewRenderProcess?.terminate() == true) terminated++
                }
                promise.resolve(terminated)
            } catch (e: Throwable) {
                promise.reject("terminate_failed", e)
            }
        }
    }

    private fun findWebViews(view: View?): List<WebView> {
        if (view == null) return emptyList()
        val out = ArrayList<WebView>()
        val stack = ArrayDeque<View>()
        stack.addLast(view)
        while (stack.isNotEmpty()) {
            val v = stack.removeLast()
            if (v is WebView) out.add(v)
            if (v is ViewGroup) {
                for (i in 0 until v.childCount) stack.addLast(v.getChildAt(i))
            }
        }
        return out
    }
}
