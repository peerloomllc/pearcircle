# PearCircle Seeder

This service runs a **blind seeder** for your PearCircle circles so their history
stays in sync even when every member's phone is offline.

## Enroll a circle

1. Open the **Seeder Dashboard** from this service's page (Tor or LAN).
2. On your phone, open **PearCircle**, pick the circle, and mint a **seed
   invite** for it.
3. Paste the seed invite into the dashboard.
4. Back in the phone app, **admit** the seeder when it requests to join.

The seeder now replicates that circle's encrypted blocks. Repeat for each circle
you want kept online.

## What it can and cannot see

The blocks it stores stay **encrypted** - the seeder keeps your circle available
without ever being able to read its locations, places, or members. Members admit
the seeder and can **revoke** it at any time, and each circle has its own
retention window (forever, 30 days, 7 days, or 24 hours) set from the dashboard.

## Notes

- **No configuration** is needed. Enrollment happens entirely from the phone app.
- **Backups** cover the seeder's identity and per-circle enrollments, so a
  restore keeps the seeder admitted without re-inviting.
- **Updates** are delivered through the StartOS marketplace; the in-app update
  checker is disabled here.
