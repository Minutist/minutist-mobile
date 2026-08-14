# Play data-safety answers — Minutist companion

The authoritative answer sheet for the Play Console Data safety form. Scoped to
what the **phone app** and its sync backend actually do. Fill the form from this,
or transfer the `Response value` into the console's exported CSV template (the
importable CSV's question IDs are specific to this app — export it from
App content → Data safety → Import to CSV, then set values per this sheet).

Basis: no analytics/crash/tracking SDK is bundled (verified — no Firebase, no
`google-services.json`); sync is end-to-end encrypted and the relay holds
ciphertext it cannot read; the connector-to-AI channel is a DESKTOP feature and
is declared on the desktop, not here.

## Overview

- **Does the app collect or share any required user data types?** Yes.
- **Is all collected user data encrypted in transit?** Yes (E2E for sync; TLS to
  the account service).
- **Do you provide a way to request data deletion?** Meetings are deletable
  in-app. Account deletion: **CONFIRM a route exists** (in-app or a web URL) —
  Play requires one. This is the one open item before submitting.

## Data types

Not collected: location, financial info, health/fitness, contacts, calendar,
SMS, web history, installed apps, photos/videos, and diagnostics/analytics
(no telemetry SDK). No data is shared with third parties, and none is used for
advertising or sold.

| Data type (Play category) | Collected | Shared | Purpose | Optional/required | Ephemeral |
|---|---|---|---|---|---|
| Audio → Voice or sound recordings | Yes | No | App functionality | Optional (user starts each recording) | No (stored + synced) |
| User-generated content → Other UGC (typed notes, transcripts, summaries) | Yes | No | App functionality | Optional | No |
| Personal info → Email address | Yes | No | Account management, App functionality | Optional (only if you sign in for sync) | No |
| Device or other IDs (the sync endpoint id) | Yes | No | App functionality | Required (for sync) | No |

Notes:
- **Audio / UGC not shared:** synced only to the user's own devices over an E2E
  channel; the relay cannot read it. Play "sharing" means transfer to a third
  party, which does not happen.
- **Email** is collected only when the user creates / signs in to a sync account;
  the app records locally without one, so it is optional.
- **Endpoint id** is an app-generated keypair identifier published to the user's
  own account directory so their other devices can find this one. Whether this
  counts as a Play "Device or other ID" is a judgement call; declaring it
  (collected, App functionality, not shared) is the safe reading. Andrew to
  confirm he is comfortable with that classification.

## Security section

- Encrypted in transit: **Yes**.
- Users can request deletion: **Yes** (pending the account-deletion route above).
- Data collection is not required to use the app (local recording works without
  an account).
- Independent security review: not claimed (leave unchecked).
- Committed to the Play Families Policy: No (not a children's app).
