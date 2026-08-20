# App Store submission — Minutist companion

Working doc for the iOS release of the Minutist phone companion.

## Export compliance

`ios/App/App/Info.plist` sets `ITSAppUsesNonExemptEncryption` to `false`. This
also suppresses the App Store Connect encryption-compliance prompt on every
upload, so the reasoning is recorded here rather than left as a bare boolean.

What the app ships, which is the part this repo can state with confidence:

- HTTPS/TLS to the account service, through the platform's own stack. None of
  that cryptography is ours.
- iroh/quinn's QUIC transport, which is TLS 1.3 via rustls. From Phase 4 onward
  that is a TLS implementation **bundled in our binary**, not the platform's.
- No proprietary or non-standard algorithm is implemented anywhere in the
  project; nothing cryptographic is authored here.

**The export-classification question is OPEN and must be settled before the
first submission.** The candidate bases are the ancillary-cryptography
exclusion (Note 4 to Category 5 Part 2), or mass-market treatment under
5D992.c with the self-classification report that entails. Note 4 turns on the
primary function being something other than information security, networking,
or the sending, receiving and storing of information — which a device-to-device
sync client plainly engages — so it is not obviously available here, and
implementing a published protocol is not by itself an exemption. The `false`
currently in `Info.plist` carries over the Android-parity assumption; it is not
the output of a completed analysis and should not be relied on as one.

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
