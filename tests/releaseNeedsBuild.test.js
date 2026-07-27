const { execFileSync } = require('child_process')

// release.sh decided NEEDS_BUILD purely from the destination selection, so
// declining GitHub/Play/App Store left it false and skipped the whole build
// phase - including the app.json version bump - after already printing that a
// build would run. Zapstore then published whatever stale APK was on disk: the
// run that intended v1.1.0 shipped v1.0.25 to the relay (2026-07-24).
//
// The rule that fixes it: the "Zapstore can republish from GitHub" shortcut is
// only valid for a version GitHub ALREADY has. These cases pin that decision
// table, including the republish path the shortcut exists to serve.

// Mirrors the guard in release.sh. Kept as a string so the test states the
// logic it is pinning rather than hiding it behind a source-file scrape.
const GUARD = `
  NEEDS_BUILD=false
  if $PUBLISH_GITHUB || $PUBLISH_PLAY || $PUBLISH_APP_STORE; then
    NEEDS_BUILD=true
  fi
  if [ "\${GH_VERSION:-}" != "$APP_VERSION" ] && ! $NEEDS_BUILD; then
    NEEDS_BUILD=true
  fi
  echo "$NEEDS_BUILD"
`

function needsBuild ({ ghVersion, appVersion, github = false, play = false, appStore = false }) {
  const script = `
    GH_VERSION=${JSON.stringify(ghVersion)}
    APP_VERSION=${JSON.stringify(appVersion)}
    PUBLISH_GITHUB=${github}
    PUBLISH_PLAY=${play}
    PUBLISH_APP_STORE=${appStore}
    ${GUARD}
  `
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim() === 'true'
}

describe('release.sh NEEDS_BUILD decision', () => {
  test('THE BUG: a version GitHub has never seen builds, even for Zapstore alone', () => {
    // Exactly the v1.1.0 run: GitHub is on 1.0.25, the target is 1.1.0, and
    // every artifact-producing destination was declined.
    expect(needsBuild({ ghVersion: '1.0.25', appVersion: '1.1.0' })).toBe(true)
  })

  test('the republish shortcut is preserved when GitHub already has the version', () => {
    // Every ZAPSTORE_ONLY path sets APP_VERSION="$GH_VERSION" before reaching
    // the guard, so the two are equal and no build is forced. This is the case
    // the shortcut exists for; breaking it would make every republish rebuild.
    expect(needsBuild({ ghVersion: '1.0.25', appVersion: '1.0.25' })).toBe(false)
  })

  test('an unreadable GitHub version builds rather than trusting local state', () => {
    // Empty means the GitHub query failed. Building needlessly is recoverable;
    // publishing a stale artifact under a new version number is not.
    expect(needsBuild({ ghVersion: '', appVersion: '1.1.0' })).toBe(true)
  })

  test('any artifact-producing destination still forces a build on its own', () => {
    expect(needsBuild({ ghVersion: '1.0.25', appVersion: '1.0.25', github: true })).toBe(true)
    expect(needsBuild({ ghVersion: '1.0.25', appVersion: '1.0.25', play: true })).toBe(true)
    expect(needsBuild({ ghVersion: '1.0.25', appVersion: '1.0.25', appStore: true })).toBe(true)
  })
})
