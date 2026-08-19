# App Store submission — Minutist companion

Working doc for the iOS release of the Minutist phone companion.

## Export compliance

`ios/App/App/Info.plist` sets `ITSAppUsesNonExemptEncryption` to `false`. This
also suppresses the App Store Connect encryption-compliance prompt on every
upload, so the reasoning is recorded here rather than left as a bare boolean.

The app's only network paths are standard HTTPS/TLS to the account service and
iroh/quinn's QUIC transport, which is TLS 1.3 over rustls — a standard, publicly
published protocol implementation, not a proprietary algorithm. Apple's export-
compliance exemption (Category 5 Part 2, Note 4 to the EAR) covers apps whose
only use of encryption is authentication or the implementation of standard
industry protocols, so `false` (the app is exempt from the "non-exempt
encryption" declaration) is the correct answer.

This matches `store/PLAY_STORE.md`'s and `store/data-safety-answers.md`'s
"Encrypted in transit: Yes" / "TLS to the account service" answers for Play —
both stores describe the same transport, standard TLS and QUIC, not a
proprietary cipher.

## Data collected

`store/data-safety-answers.md` is the source of truth for what the app
collects and why (audio recordings, typed notes/transcripts/summaries, account
email, the sync endpoint id; none shared with third parties, none used for
advertising). The iOS app has the same data behaviour as the Android app it is
ported from, so that answer sheet applies unchanged; it is not restated here to
avoid the two documents drifting apart.
