#!/usr/bin/env bash
# Assembles a release directory from the evidence CI produced for a commit, after verifying it. Nothing is rebuilt here: the release
# archive is the file CI made from that commit, signed (GitHub artifact attestations, Sigstore) together with its SBOM, and the image
# scan report belongs to the same commit.
#
#   deploy/assemble-release.sh VERSION COMMIT CHANGE_FILE [OUTPUT_DIRECTORY]
#
#   VERSION       0.1.N
#   COMMIT        the 40-character commit that CI built (must be the checked-out HEAD, so that the scan exceptions are the ones CI used); its VERSION
#                 file must say VERSION, because the image CI built carries that release version
#   CHANGE_FILE   JSON with sourceAuthority, summary, details (list), verification, filesChanged (list) and optionally requiredMigration
#   OUTPUT        default ./Nuvrion-v<VERSION>; the directory is created and must not exist
#
# Needs: gh (signed in), jq, node, tar, and sha256sum or shasum. Exits non-zero, leaving no release directory, if anything fails to verify.
set -Eeuo pipefail

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
[[ $# -ge 3 && $# -le 4 ]] || usage
version="$1"; commit="$2"; change_file="$3"; output="${4:-./Nuvrion-v$version}"

[[ "$version" =~ ^0\.1\.[0-9]+$ ]] || { echo "VERSION must look like 0.1.171." >&2; exit 2; }
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "COMMIT must be a full 40-character commit." >&2; exit 2; }
[[ -f "$change_file" ]] || { echo "The change file does not exist: $change_file" >&2; exit 2; }
[[ ! -e "$output" ]] || { echo "The output directory already exists: $output" >&2; exit 2; }
for tool in gh jq node tar; do command -v "$tool" >/dev/null || { echo "Required command is unavailable: $tool" >&2; exit 1; }; done
if command -v sha256sum >/dev/null; then sha() { sha256sum "$1" | cut -d' ' -f1; }; else sha() { shasum -a 256 "$1" | cut -d' ' -f1; }; fi

repo_root="$(git rev-parse --show-toplevel)"
[[ "$(git -C "$repo_root" rev-parse HEAD)" == "$commit" ]] || { echo "HEAD is not $commit; check that commit out so the scan exceptions match what CI used." >&2; exit 1; }
repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
workflow="$repo/.github/workflows/ci.yml"

[[ "$(git -C "$repo_root" show "$commit:VERSION" 2>/dev/null | tr -d '[:space:]')" == "$version" ]] \
  || { echo "The VERSION file of $commit does not say $version; the image CI built carries that version. Change VERSION in a commit and let CI build it." >&2; exit 1; }
jq -e '.summary and (.details|type=="array") and .verification and (.filesChanged|type=="array") and .sourceAuthority' "$change_file" >/dev/null \
  || { echo "The change file needs sourceAuthority, summary, details, verification and filesChanged." >&2; exit 2; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "Finding the CI run of $commit..."
run_id="$(gh run list --workflow CI --commit "$commit" --event push --status success --json databaseId --jq '.[0].databaseId // empty')"
[[ -n "$run_id" ]] || { echo "No successful push run of CI exists for $commit. Push it and wait for CI." >&2; exit 1; }
gh run view "$run_id" --json jobs --jq '.jobs[] | select(.name=="release-evidence") | .conclusion' | grep -qx success \
  || { echo "The release-evidence job did not succeed in run $run_id." >&2; exit 1; }

echo "Downloading release-evidence-$commit from run $run_id..."
gh run download "$run_id" --name "release-evidence-$commit" --dir "$work/evidence"
cd "$work/evidence"

echo "Checking the files against the checksums CI recorded..."
if command -v sha256sum >/dev/null; then sha256sum -c SHA256SUMS.evidence.txt >/dev/null; else shasum -a 256 -c SHA256SUMS.evidence.txt >/dev/null; fi
archive="Nuvrion-Server-Overlay-$commit.tar.gz"
for file in "$archive" nuvrion-sbom.cdx.json nuvrion-build-provenance.json image-scan.json image-scan-summary.json build-provenance.attestation.sigstore.json sbom.attestation.sigstore.json; do
  [[ -f "$file" ]] || { echo "The evidence is missing $file." >&2; exit 1; }
done
if tar -tzf "$archive" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then echo "The archive contains an unsafe path." >&2; exit 1; fi

# The image CI built and scanned. Present for every commit since the image archive was added to CI; older commits have none and are released the old way.
image_tar="Nuvrion-Image-$commit.tar"
image_id=""
if [[ -f "$image_tar" ]]; then
  for file in image-sbom.cdx.json image-sbom.attestation.sigstore.json image-id.txt; do
    [[ -f "$file" ]] || { echo "The evidence is missing $file (needed with the image archive)." >&2; exit 1; }
  done
  image_id="$(tr -d '[:space:]' < image-id.txt)"
  [[ "$image_id" =~ ^[0-9a-f]{64}$ ]] || { echo "image-id.txt does not hold an image id." >&2; exit 1; }
  # the id CI recorded must be the id of the configuration inside the archive, so that what is loaded on the host is what was scanned
  archive_config="$(tar -xOf "$image_tar" manifest.json | jq -r '.[0].Config' | sed -E 's#.*/##; s#\.json$##; s#^sha256:##')"
  [[ "$archive_config" == "$image_id" ]] || { echo "The image archive holds image $archive_config, not $image_id." >&2; exit 1; }
fi

echo "Verifying the build-provenance attestation (signed by $workflow for $commit)..."
gh attestation verify "$archive" --bundle build-provenance.attestation.sigstore.json --repo "$repo" \
  --signer-workflow "$workflow" --source-digest "$commit" --predicate-type https://slsa.dev/provenance/v1 >/dev/null
echo "Verifying the SBOM attestation..."
gh attestation verify "$archive" --bundle sbom.attestation.sigstore.json --repo "$repo" \
  --signer-workflow "$workflow" --source-digest "$commit" --predicate-type https://cyclonedx.org/bom >/dev/null
if [[ -n "$image_id" ]]; then
  echo "Verifying the image archive and its SBOM (same workflow, same commit)..."
  gh attestation verify "$image_tar" --bundle build-provenance.attestation.sigstore.json --repo "$repo" \
    --signer-workflow "$workflow" --source-digest "$commit" --predicate-type https://slsa.dev/provenance/v1 >/dev/null
  gh attestation verify "$image_tar" --bundle image-sbom.attestation.sigstore.json --repo "$repo" \
    --signer-workflow "$workflow" --source-digest "$commit" --predicate-type https://cyclonedx.org/bom >/dev/null
fi

echo "Checking the SBOM and build provenance against this checkout, and the image scan policy..."
(cd "$repo_root" && node tools/generate-sbom.js verify "$work/evidence/nuvrion-sbom.cdx.json" >/dev/null)
jq -e --arg c "$commit" '.sourceRevision == $c' nuvrion-build-provenance.json >/dev/null || { echo "The build provenance names another commit." >&2; exit 1; }
(cd "$repo_root" && NUVRION_SOURCE_REVISION="$commit" NUVRION_BUILD_VERSION="$(jq -r .version "$work/evidence/nuvrion-build-provenance.json")" \
  node tools/create-build-provenance.js verify "$work/evidence/nuvrion-build-provenance.json" >/dev/null)
(cd "$repo_root" && node tools/evaluate-image-scan.js "$work/evidence/image-scan.json" --exceptions deploy/image-scan-exceptions.json --max-age-hours 72 --summary "$work/scan-summary.json" >/dev/null) \
  || { echo "The image scan does not pass the policy:" >&2; cat "$work/scan-summary.json" >&2; exit 1; }

archive_sha="$(sha "$archive")"
final="$work/release"
mkdir "$final"
cp "$archive" "$final/Nuvrion-Server-Overlay-$version.tar.gz"
cp nuvrion-sbom.cdx.json nuvrion-build-provenance.json image-scan.json build-provenance.attestation.sigstore.json sbom.attestation.sigstore.json "$final/"
cp "$work/scan-summary.json" "$final/image-scan-summary.json"
evidence_files='["nuvrion-sbom.cdx.json","nuvrion-build-provenance.json","image-scan.json","image-scan-summary.json","build-provenance.attestation.sigstore.json","sbom.attestation.sigstore.json"]'
image_json='null'
scan_note="the image that was scanned was built in CI from the same commit and the same Containerfiles, on arm64; the image on the host is built there from the signed archive"
if [[ -n "$image_id" ]]; then
  cp "$image_tar" "$final/Nuvrion-Image-$version.tar"
  cp image-sbom.cdx.json image-sbom.attestation.sigstore.json "$final/"
  evidence_files="$(jq -c '. + ["image-sbom.cdx.json","image-sbom.attestation.sigstore.json"]' <<< "$evidence_files")"
  image_json="$(jq -nc --arg file "Nuvrion-Image-$version.tar" --arg sha "$(sha "$image_tar")" --arg id "$image_id" '{file:$file,sha256:$sha,imageId:$id}')"
  scan_note="the image that was scanned is the image that is deployed: the archive is signed, and the host checks the id of the image it loads against the id recorded here"
fi

jq -n --arg version "$version" --arg commit "$commit" --arg sha "$archive_sha" --arg date "$(date -u +%F)" --arg runUrl "https://github.com/$repo/actions/runs/$run_id" \
  --arg workflow "$workflow" --arg verifiedAt "$(date -u +%FT%TZ)" --slurpfile change "$change_file" --slurpfile scan "$final/image-scan-summary.json" \
  --argjson files "$evidence_files" --argjson image "$image_json" --arg scanNote "$scan_note" '
  {
    product: "Nuvrion", version: $version, channel: "lab", preparedDate: $date, sourceBaselineCommit: $commit,
    sourceAuthority: $change[0].sourceAuthority,
    server: ({ artifact: "Nuvrion-Server-Overlay-\($version).tar.gz", sha256: $sha, image: "localhost/nuvrion:\($version)",
               requiredMigration: ($change[0].requiredMigration // "0028"), health: "pending-post-deploy-check" } + (if $image then {imageArchive: $image} else {} end)),
    change: { summary: $change[0].summary, details: $change[0].details, verification: $change[0].verification, filesChanged: $change[0].filesChanged },
    supplyChain: {
      archiveSha256: $sha,
      builtBy: $workflow, ciRun: $runUrl,
      files: $files,
      attestations: { buildProvenance: "https://slsa.dev/provenance/v1", sbom: "https://cyclonedx.org/bom", verifiedWith: "gh attestation verify", verifiedAt: $verifiedAt },
      imageScan: { scanner: "trivy", status: $scan[0].status, blockingFindings: $scan[0].blocking, acceptedFindings: ($scan[0].accepted | length), counts: $scan[0].counts,
                   note: $scanNote }
    }
  }' > "$final/release-manifest.json"

printf '# Nuvrion v%s\n%s\n' "$version" "$(jq -r .change.summary "$final/release-manifest.json")" > "$final/RELEASE-NOTES.md"
(cd "$final" && for f in $(ls | grep -v '^SHA256SUMS.txt$' | sort); do printf '%s  %s\n' "$(sha "$f")" "$f"; done > SHA256SUMS.txt)

mv "$final" "$output"
echo
echo "Release directory: $output"
echo "  archive sha256   $archive_sha"
echo "  commit           $commit (CI run $run_id)"
echo "  image scan       $(jq -r '"\(.status), \(.blocking) blocking, \(.accepted|length) accepted"' "$output/image-scan-summary.json")"
[[ -z "$image_id" ]] || echo "  image archive    Nuvrion-Image-$version.tar (image id ${image_id:0:12}, signed, the image that was scanned)"
echo "Next: copy it to the host's releases directory, then run upgrade-nuvrion.sh <dir> --check and read it before --yes."
