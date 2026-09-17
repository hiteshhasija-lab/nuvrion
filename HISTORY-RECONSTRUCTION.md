# About this branch

`vm-deployed-history` is a reconstructed commit history for the Nuvrion application source
that has actually been running on the RHEL9 lab VM (`nuvrion.lab.sps`) — as opposed to
`main`, whose history is unrelated and does not reflect what's deployed.

The real deployed source was never tracked in git. It only ever existed as a sequence of
versioned "Server Overlay" release tarballs on the VM
(`~/nuvrion-upgrades/releases/Nuvrion-v<version>/`), each covering exactly the application
directories that change per release: `apps/`, `database/`, `deploy/`, `modules/`,
`providers/`.

This branch has one commit per available overlay, from **v0.1.85 through v0.1.121**
(36 commits, built 2026-09-17), extracted directly from those archived tarballs. Each
commit's:
- **content** is that overlay's exact file tree, nothing added or guessed
- **date** is the overlay tarball's real build timestamp on the VM
- **message** is that version's own release-notes entry, pulled verbatim from
  `RELEASE-NOTES.md` in the release directory

**What's missing, and why:** versions before v0.1.85 are not recoverable. No overlay
tarball, container image, or other artifact survives for v0.1.47 through v0.1.84 (38
versions) or anything before v0.1.28 — that history is genuinely gone, not omitted by
choice. A handful of earlier fragments (v0.1.28–37, v0.1.44–46) exist as raw build folders
or standalone zips on the VM but were left out of this branch to avoid a misleading gap in
the middle of the sequence; ask if you want those added as a separate, clearly-marked
prefix. v0.1.107 has no artifact either — it appears to have been built but never
successfully deployed (likely auto-rolled-back by the upgrade tooling), so its absence here
matches reality rather than being a gap in the reconstruction.

This branch does not touch `main`. What (if anything) to do with the two histories —
merge, replace, keep as parallel references — is an open decision for whoever owns this
repo.
