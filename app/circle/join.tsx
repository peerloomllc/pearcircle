import { Redirect } from 'expo-router'

// Universal Link landing route for https://peerloomllc.com/circle/join?...
// The URL itself is delivered to Linking.addEventListener in app/index.tsx
// (via RCTLinkingManager). This route exists only so expo-router has a
// matching path and doesn't flash the +not-found screen before redirecting
// back to the index where the WebView lives.
//
// <Redirect> is required here (not router.replace in a useEffect) because
// on cold start the root navigator hasn't finished mounting yet and an
// imperative navigate throws "Attempted to navigate before mounting the
// Root Layout component". <Redirect> defers until the navigator is ready.
export default function JoinRoute() {
  return <Redirect href="/" />
}
