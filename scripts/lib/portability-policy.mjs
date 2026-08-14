const SHA256 = /^[0-9a-f]{64}$/;
const EXPECTED_PROFILES = new Map([
  ["windows-x64", { platform: "win32", architecture: "x64", runner: "windows-2025" }],
  ["linux-x64", { platform: "linux", architecture: "x64", runner: "ubuntu-24.04" }],
  ["macos-x64", { platform: "darwin", architecture: "x64", runner: "macos-15-intel" }],
  ["macos-arm64", { platform: "darwin", architecture: "arm64", runner: "macos-15" }]
]);
const ARTIFACT_KEYS = ["claudeCurrent", "claudeMinimum", "codexCurrent", "codexPrevious", "node"];
const CURRENT_TEST_COMMAND = [
  "node --test --test-concurrency=1 --test-reporter=dot",
  "tests/args.test.mjs",
  "tests/broker-endpoint.test.mjs",
  "tests/bump-version.test.mjs",
  "tests/commands.test.mjs",
  "tests/generate-app-server-types.test.mjs",
  "tests/git.test.mjs",
  "tests/job-control.test.mjs",
  "tests/platform-policy.test.mjs",
  "tests/process.test.mjs",
  "tests/render.test.mjs",
  "tests/runtime.test.mjs",
  "tests/state.test.mjs",
  "tests/portability/*.test.mjs"
].join(" ");
const WINDOWS_TEST_BLOCK = [
  "      - name: Run current Windows suite",
  "        if: ${{ matrix.platform == 'win32' }}",
  "        shell: pwsh",
  "        run: |",
  "          if (",
  "            $env:SystemDrive -cne 'C:' -or",
  "            $env:GITHUB_RUN_ID -notmatch '^\\d+$' -or",
  "            $env:GITHUB_RUN_ATTEMPT -notmatch '^\\d+$'",
  "          ) {",
  "            throw 'Unsafe Windows test environment.'",
  "          }",
  "          $tempRoot = Join-Path $env:SystemDrive \"p6-temp-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT\"",
  "          if (Test-Path -LiteralPath $tempRoot) {",
  "            throw 'Windows test root already exists.'",
  "          }",
  "          New-Item -ItemType Directory -Path $tempRoot -ErrorAction Stop | Out-Null",
  "          $item = Get-Item -LiteralPath $tempRoot -Force",
  "          if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {",
  "            throw 'Windows test root is not an ordinary directory.'",
  "          }",
  "          $env:TEMP = $tempRoot",
  "          $env:TMP = $tempRoot",
  "          npm ci --ignore-scripts --no-audit --no-fund",
  "          if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
  "          npm test",
  "          exit $LASTEXITCODE"
].join("\n");

export function validatePortabilityPackage(packageJson) {
  return packageJson?.scripts?.test === CURRENT_TEST_COMMAND
    ? []
    : ["P6E_PACKAGE_TEST: npm test must run the exact current v0.2 support suite"];
}

export function validatePortabilityProfiles(registry) {
  const errors = [];
  if (
    registry?.schemaVersion !== "portability-profiles-v1" ||
    registry?.nodeVersion !== "24.18.1" ||
    registry?.ciAcquisition !== false ||
    !Array.isArray(registry?.profiles) ||
    registry.profiles.length !== EXPECTED_PROFILES.size
  ) {
    return ["P6E_PROFILE_ROOT: invalid portability profile registry"];
  }
  const ids = new Set();
  for (const profile of registry.profiles) {
    const expected = EXPECTED_PROFILES.get(profile?.id);
    if (
      !expected ||
      ids.has(profile.id) ||
      profile.platform !== expected.platform ||
      profile.architecture !== expected.architecture ||
      profile.runner !== expected.runner ||
      /latest/i.test(profile.runner) ||
      profile.supportStatus !== "runtime-supported"
    ) {
      errors.push(`P6E_PROFILE: invalid tuple or runner for ${profile?.id ?? "unknown"}`);
      continue;
    }
    ids.add(profile.id);
    if (Object.keys(profile.artifacts ?? {}).sort().join("\0") !== ARTIFACT_KEYS.join("\0")) {
      errors.push(`P6E_PROFILE_ARTIFACT: invalid artifact set for ${profile.id}`);
      continue;
    }
    for (const [name, artifact] of Object.entries(profile.artifacts)) {
      let url;
      try {
        url = new URL(artifact?.url);
      } catch {
        url = null;
      }
      if (
        !artifact?.version ||
        !artifact?.file ||
        !url ||
        url.protocol !== "https:" ||
        !url.pathname.endsWith(`/${artifact.file}`) ||
        /latest/i.test(artifact.url) ||
        !SHA256.test(artifact.sha256 ?? "") ||
        (name.startsWith("codex") && profile.platform === "linux" && !SHA256.test(artifact.sigstoreSha256 ?? ""))
      ) {
        errors.push(`P6E_PROFILE_ARTIFACT: invalid ${name} artifact for ${profile.id}`);
      }
    }
  }
  if (ids.size !== EXPECTED_PROFILES.size) errors.push("P6E_PROFILE_SET: exact profile coverage is required");
  return errors;
}

export function validatePortabilityWorkflow(text, registry) {
  const errors = [];
  const normalized = String(text ?? "").replaceAll("\r\n", "\n");
  if (
    !/^on:\n  pull_request:\n/m.test(normalized) ||
    /pull_request_target|workflow_dispatch/.test(normalized) ||
    !/^permissions:\n  contents: read$/m.test(normalized)
  ) {
    errors.push("P6E_WORKFLOW_PERMISSIONS: pull_request with contents:read is required");
  }
  if (
    !normalized.includes("actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd") ||
    !normalized.includes("actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f") ||
    !normalized.includes("persist-credentials: false") ||
    !normalized.includes("node-version: 24.18.1") ||
    !normalized.includes("package-manager-cache: false")
  ) {
    errors.push("P6E_WORKFLOW_ACTIONS: exact actions and Node setup are required");
  }
  for (const profile of registry?.profiles ?? []) {
    if (!normalized.includes(`- id: ${profile.id}`) || !normalized.includes(`runner: ${profile.runner}`)) {
      errors.push(`P6E_WORKFLOW_PROFILE: missing ${profile.id}`);
    }
  }
  if (
    !normalized.includes("node scripts/write-portability-runner-evidence.mjs") ||
    !normalized.includes("node scripts/validate-p5.mjs") ||
    !/^    strategy:\n      fail-fast: false\n      matrix:/m.test(normalized) ||
    /continue-on-error\s*:/.test(normalized) ||
    !normalized.includes("if: ${{ matrix.platform != 'win32' }}") ||
    !normalized.includes("node --test --test-concurrency=1 tests/portability/*.test.mjs") ||
    !normalized.includes(WINDOWS_TEST_BLOCK) ||
    !/^  security:\n    name: Security$/m.test(normalized) ||
    !normalized.includes("./scripts/install-p3-tool.ps1") ||
    !normalized.includes("@('actionlint', 'zizmor', 'osv-scanner', 'gitleaks')") ||
    !normalized.includes("actionlint.exe") ||
    !normalized.includes("zizmor.exe --offline --persona pedantic --strict-collection .github/workflows") ||
    !normalized.includes("osv-scanner.exe scan --lockfile package-lock.json") ||
    !normalized.includes("gitleaks.exe dir --redact --no-banner .") ||
    !/^  dependency-review:\n    name: Dependency review$/m.test(normalized) ||
    !normalized.includes("actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294") ||
    !/^  portability:\n    name: Portability CI$/m.test(normalized) ||
    !normalized.includes("needs: [runtime, security, dependency-review]") ||
    !normalized.includes('test "$RUNTIME_RESULT" = success') ||
    !normalized.includes('test "$SECURITY_RESULT" = success') ||
    !normalized.includes('test "$DEPENDENCY_RESULT" = success')
  ) {
    errors.push("P6E_WORKFLOW_GATE: exact tests and terminal gate are required");
  }
  if (
    /\b(?:curl|wget|Invoke-WebRequest|npm\s+(?:i|install)|pnpm|yarn|download-artifact|upload-artifact|actions\/cache)\b/i.test(normalized) ||
    /secrets\./.test(normalized)
  ) {
    errors.push("P6E_WORKFLOW_ACQUISITION: direct downloads, package installs, caches, artifacts, and secrets are forbidden");
  }
  return errors;
}
