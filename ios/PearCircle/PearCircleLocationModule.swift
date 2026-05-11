import Foundation
import CoreLocation
import Network
import UIKit
import React

// iOS counterpart to Android's PearCircleLocationModule + LocationService.
// On iOS the OS itself handles the "foreground service" role: with the
// `location` UIBackgroundMode set in Info.plist and Always authorization
// granted, CLLocationManager keeps delivering updates while the app is
// suspended. There is no separate Service to stand up.
//
// Emit contract matches Android exactly so the worklet's IPC handlers
// (`location:update`, `network:changed` in src/bare.js) need zero
// changes:
//   PearCircleLocation:update
//     { lat, lon, accuracy, ts, speed, battery, isCharging }
//   PearCircleLocation:network:changed
//     { transport, netHandle }
@objc(PearCircleLocation)
class PearCircleLocationModule: RCTEventEmitter, CLLocationManagerDelegate {

  private static let UPDATE_EVENT = "PearCircleLocation:update"
  private static let NETWORK_EVENT = "PearCircleLocation:network:changed"
  private static let DEBOUNCE_SECONDS: TimeInterval = 2.0

  private var manager: CLLocationManager?
  private var hasListeners = false

  // Resolver for an in-flight startUpdates() call that's blocked on
  // the user's response to the location-permission dialog. didChange
  // fires later with the result; we resolve(true|false) at that point.
  // If a second startUpdates() arrives before the first resolves we
  // resolve the prior one as false rather than leaking it.
  private var pendingResolve: RCTPromiseResolveBlock?

  // Network-change debounce. iOS emits a burst of NWPathMonitor
  // callbacks during a single transition (interface up, address
  // assigned, default route changed, ...). We collapse them with a
  // 2s debounce, identical to the Android side. lastTransport guards
  // against emitting when the actual stack didn't change. The
  // monotonic netSeq stands in for Android's network handle so the
  // worklet has a numeric tag to log.
  private var pathMonitor: NWPathMonitor?
  private let pathQueue = DispatchQueue(label: "com.pearcircle.netpath")
  private var debounceItem: DispatchWorkItem?
  private var hasSeenInitialPath = false
  private var lastTransport: String?
  private var netSeq: Int64 = 0

  override init() {
    super.init()
    // Battery monitoring must be enabled before batteryLevel /
    // batteryState read anything other than -1 / .unknown. Apple
    // requires this on the main thread.
    DispatchQueue.main.async {
      UIDevice.current.isBatteryMonitoringEnabled = true
    }
    startPathMonitor()
  }

  deinit {
    pathMonitor?.cancel()
  }

  override static func requiresMainQueueSetup() -> Bool { return true }

  override func supportedEvents() -> [String] {
    return [PearCircleLocationModule.UPDATE_EVENT, PearCircleLocationModule.NETWORK_EVENT]
  }

  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  // MARK: - JS-exposed API

  @objc func startUpdates(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let mgr = self.ensureManager()
      let status: CLAuthorizationStatus
      if #available(iOS 14.0, *) {
        status = mgr.authorizationStatus
      } else {
        status = CLLocationManager.authorizationStatus()
      }
      switch status {
      case .notDetermined:
        if let prior = self.pendingResolve {
          prior(false)
        }
        self.pendingResolve = resolve
        // Always > WhenInUse for background sharing; iOS may show
        // WhenInUse first and prompt for the Always upgrade later
        // through its own provisional flow.
        mgr.requestAlwaysAuthorization()
      case .restricted, .denied:
        resolve(false)
      case .authorizedWhenInUse:
        // Foreground updates work; background callbacks won't fire
        // until the user upgrades to Always. Start anyway and request
        // the upgrade -- iOS suppresses the duplicate dialog itself.
        mgr.requestAlwaysAuthorization()
        self.startUpdatesNow(mgr)
        resolve(true)
      case .authorizedAlways:
        self.startUpdatesNow(mgr)
        resolve(true)
      @unknown default:
        resolve(false)
      }
    }
  }

  @objc func stopUpdates(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      self.manager?.stopUpdatingLocation()
      resolve(true)
    }
  }

  // Read the current authorization status without triggering a dialog.
  // Used by the shell to decide whether to show the priming screen and
  // by the home banner to nudge users stuck below Always toward the
  // iOS Settings deep-link.
  @objc func getAuthorizationStatus(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let mgr = self.ensureManager()
      let status: CLAuthorizationStatus
      if #available(iOS 14.0, *) {
        status = mgr.authorizationStatus
      } else {
        status = CLLocationManager.authorizationStatus()
      }
      let s: String
      switch status {
      case .notDetermined:        s = "notDetermined"
      case .restricted:           s = "restricted"
      case .denied:               s = "denied"
      case .authorizedWhenInUse:  s = "whenInUse"
      case .authorizedAlways:     s = "always"
      @unknown default:           s = "unknown"
      }
      resolve(s)
    }
  }

  // Deep-link into the iOS Settings app's PearCircle entry. Apple allows
  // this URL; it's the canonical "send the user to fix this permission"
  // path. Resolves true on a successful open.
  @objc func openSettings(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      guard let url = URL(string: UIApplication.openSettingsURLString) else {
        resolve(false)
        return
      }
      UIApplication.shared.open(url, options: [:]) { ok in
        resolve(ok)
      }
    }
  }

  // MARK: - CLLocationManagerDelegate

  // iOS 14+ delegate.
  @available(iOS 14.0, *)
  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    handleAuthChange(manager: manager, status: manager.authorizationStatus)
  }

  // Pre-iOS 14 delegate. Kept for completeness; deployment target is
  // 15.1 today but the bridging header doesn't strip it.
  func locationManager(
    _ manager: CLLocationManager,
    didChangeAuthorization status: CLAuthorizationStatus
  ) {
    handleAuthChange(manager: manager, status: status)
  }

  func locationManager(
    _ manager: CLLocationManager,
    didUpdateLocations locations: [CLLocation]
  ) {
    guard let loc = locations.last else { return }
    emitLocation(loc)
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    NSLog("PearCircleLocation: didFailWithError %@", error.localizedDescription)
  }

  // MARK: - Helpers

  private func ensureManager() -> CLLocationManager {
    if let m = manager { return m }
    let m = CLLocationManager()
    m.delegate = self
    m.desiredAccuracy = kCLLocationAccuracyBest
    // 10m matches Android's effective cadence (FusedLocationProvider
    // 5-10s with HIGH_ACCURACY priority). Tighter values burn battery
    // for sub-block precision the geofence layer doesn't need.
    m.distanceFilter = 10
    m.pausesLocationUpdatesAutomatically = false
    // allowsBackgroundLocationUpdates needs UIBackgroundModes "location"
    // in Info.plist (set) and Always authorization at runtime; iOS
    // silently ignores the flag otherwise.
    m.allowsBackgroundLocationUpdates = true
    m.showsBackgroundLocationIndicator = true
    manager = m
    return m
  }

  private func startUpdatesNow(_ mgr: CLLocationManager) {
    mgr.startUpdatingLocation()
  }

  private func handleAuthChange(manager: CLLocationManager, status: CLAuthorizationStatus) {
    let resolve = pendingResolve
    pendingResolve = nil
    switch status {
    case .authorizedAlways, .authorizedWhenInUse:
      startUpdatesNow(manager)
      resolve?(true)
    case .denied, .restricted:
      resolve?(false)
    case .notDetermined:
      // Still pending; restash so the next callback resolves.
      pendingResolve = resolve
    @unknown default:
      resolve?(false)
    }
  }

  private func emitLocation(_ loc: CLLocation) {
    guard hasListeners else { return }
    let level = UIDevice.current.batteryLevel
    let battery: Any = level >= 0 ? Int(round(level * 100)) : NSNull()
    let state = UIDevice.current.batteryState
    // Treat .full as charging so a plugged-in 100%-charged device
    // shows the bolt, matching Android's BATTERY_STATUS_FULL handling.
    let isCharging = state == .charging || state == .full
    let accuracy = loc.horizontalAccuracy >= 0 ? loc.horizontalAccuracy : 0
    let speed = loc.speed >= 0 ? loc.speed : 0
    let payload: [String: Any] = [
      "lat": loc.coordinate.latitude,
      "lon": loc.coordinate.longitude,
      "accuracy": accuracy,
      "ts": loc.timestamp.timeIntervalSince1970 * 1000,
      "speed": speed,
      "battery": battery,
      "isCharging": isCharging,
    ]
    sendEvent(withName: PearCircleLocationModule.UPDATE_EVENT, body: payload)
  }

  // MARK: - Network change

  private func startPathMonitor() {
    let monitor = NWPathMonitor()
    pathMonitor = monitor
    monitor.pathUpdateHandler = { [weak self] path in
      self?.onPathUpdate(path)
    }
    monitor.start(queue: pathQueue)
  }

  private func onPathUpdate(_ path: NWPath) {
    let transport = transportName(path)
    if !hasSeenInitialPath {
      // Skip the first satisfied path: it's the network we're already
      // running on. Re-announcing on cold-start is wasted work.
      hasSeenInitialPath = true
      lastTransport = transport
      return
    }
    if lastTransport == transport { return }
    lastTransport = transport
    debounceItem?.cancel()
    let work = DispatchWorkItem { [weak self] in
      self?.emitNetworkChanged(transport)
    }
    debounceItem = work
    pathQueue.asyncAfter(deadline: .now() + PearCircleLocationModule.DEBOUNCE_SECONDS, execute: work)
  }

  private func transportName(_ path: NWPath) -> String {
    if path.status != .satisfied { return "unknown" }
    if path.usesInterfaceType(.wifi) { return "wifi" }
    if path.usesInterfaceType(.cellular) { return "cellular" }
    if path.usesInterfaceType(.wiredEthernet) { return "ethernet" }
    if path.usesInterfaceType(.other) { return "vpn" }
    return "unknown"
  }

  private func emitNetworkChanged(_ transport: String) {
    guard hasListeners else { return }
    netSeq += 1
    let payload: [String: Any] = [
      "transport": transport,
      "netHandle": Double(netSeq),
    ]
    sendEvent(withName: PearCircleLocationModule.NETWORK_EVENT, body: payload)
  }
}
