import { Redirect } from 'expo-router'

// Legacy landing route for the custom-scheme invite pear://pearcircle/join?...
// (and any link that resolves to /join). Like app/circle/join.tsx, the URL
// itself is delivered to Linking.addEventListener in app/index.tsx, which
// processes the invite; this route exists only so expo-router has a matching
// path and doesn't flash +not-found before redirecting to the index where
// the WebView lives.
//
// <Redirect> is required (not router.replace in a useEffect) because on cold
// start the root navigator hasn't finished mounting and an imperative navigate
// throws "Attempted to navigate before mounting the Root Layout component".
//
// This previously rendered a blank #111 screen and emitted a 'pearLink' event
// that nothing listened for, so any invite routed here was silently dropped
// (storage/UX audit 2026-06-22, fix 3a).
export default function JoinRoute() {
  return <Redirect href="/" />
}
