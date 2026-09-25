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

## 2026-09-24: `main` replaced with this branch's history, plus one catch-up commit

The open decision above has been made: `main` was force-pushed to this branch's tip
(`11c3664`) plus one new commit, `61fdea3` — "Sync main to actual deployed state
(v0.1.121 reconstruction -> v0.1.149 live)". That commit's content was sourced by direct
extraction from the live `nuvrion-api` container on NOVAAPP01, not guessed or copied from
the old `main`, matching this branch's own standard of "nothing added or guessed."

Per-version history for v0.1.122 through v0.1.148 is **not** recoverable — no artifacts
survive for that range either, same as the gaps already documented above. The catch-up
commit says so in its own message rather than implying those versions never existed.

The previous, unrelated `main` history is preserved at the `main-pre-replica-backup-20260924`
branch on `origin`, in case anything there is ever needed.

This restructuring also brought the release pipeline itself in line with NovaDesk's and
NovaConnect's (git-tracked `Containerfile.base`/`Containerfile.overlay` at repo root, a real
`~/nuvrion` git checkout on NOVAAPP01 replacing the untracked `~/nuvrion-native-build`, and
`upgrade-nuvrion.sh` swapping via a movable `:stable` image tag + `systemctl --user restart`
instead of a raw `podman stop`/`rm`/`run`).
